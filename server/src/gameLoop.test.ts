import {
  buildInitialWorld,
  hex,
  hexEquals,
  makeRng,
  type ServerMessage,
  type World,
} from '@hivemind/shared';
import { createGameLoop, type GameLoopPort } from './gameLoop.js';

interface Sent {
  readonly playerId: string;
  readonly msg: ServerMessage;
}

const makePort = (validate?: (w: string) => Promise<boolean>) => {
  const sent: Sent[] = [];
  const port: GameLoopPort = {
    sendTo: (playerId, msg) => {
      sent.push({ playerId, msg });
    },
    validateWord: validate ?? (async () => true),
  };
  return { port, sent };
};

const players = [
  { id: 'p-host', side: 'self' as const },
  { id: 'p-joiner', side: 'opponent' as const },
] as const;

describe('gameLoop: ticking + snapshots', () => {
  test('manualTick advances world.t deterministically', () => {
    const { port } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    const before = loop.getWorld().t;
    loop.manualTick(0.5);
    expect(loop.getWorld().t).toBeCloseTo(before + 0.5);
  });

  test('snapshots fire every Nth tick (tickHz/snapshotHz) for both players', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop(
      { players, seed: 1, tickHz: 30, snapshotHz: 5 },
      port,
    );
    // 5 ticks: no snapshot yet.
    for (let i = 0; i < 5; i++) loop.manualTick(1 / 30);
    expect(sent.filter((s) => s.msg.type === 'SNAPSHOT')).toHaveLength(0);
    // 6th tick: each player gets one snapshot.
    loop.manualTick(1 / 30);
    const snaps = sent.filter((s) => s.msg.type === 'SNAPSHOT');
    expect(snaps).toHaveLength(2);
    expect(new Set(snaps.map((s) => s.playerId))).toEqual(
      new Set(['p-host', 'p-joiner']),
    );
  });

  test('snapshots are perspective-swapped per player', () => {
    const w0 = buildInitialWorld(makeRng(1), {
      selfId: 'p-host',
      opponentId: 'p-joiner',
    });
    const initialWorld: World = {
      ...w0,
      self: { ...w0.self, honey: 17 },
      opponent: { ...w0.opponent, honey: 4 },
    };
    const { port, sent } = makePort();
    const loop = createGameLoop(
      { players, seed: 1, tickHz: 30, snapshotHz: 30, initialWorld },
      port,
    );
    loop.manualTick(1 / 30);
    const snaps = sent.filter((s) => s.msg.type === 'SNAPSHOT');
    const hostSnap = snaps.find((s) => s.playerId === 'p-host')!;
    const joinerSnap = snaps.find((s) => s.playerId === 'p-joiner')!;
    if (hostSnap.msg.type !== 'SNAPSHOT' || joinerSnap.msg.type !== 'SNAPSHOT') {
      throw new Error('expected SNAPSHOT messages');
    }
    // The viewer-swap is the strict invariant; absolute honey values just
    // need to be in the right order of magnitude (regen rate is tunable).
    expect(hostSnap.msg.world.self.honey).toBeGreaterThanOrEqual(17);
    expect(hostSnap.msg.world.opponent.honey).toBeGreaterThanOrEqual(4);
    expect(hostSnap.msg.world.self.honey).toBeGreaterThan(
      hostSnap.msg.world.opponent.honey,
    );
    expect(hostSnap.msg.world.self.honey).toBe(joinerSnap.msg.world.opponent.honey);
    expect(hostSnap.msg.world.opponent.honey).toBe(joinerSnap.msg.world.self.honey);
  });
});

describe('gameLoop: command routing', () => {
  test('host commands modify world.self; joiner commands modify world.opponent', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    const w0 = loop.getWorld();
    const hostPetal = w0.patches[0]!.petals[0]!.hex;
    const joinerPetal = w0.patches[0]!.petals[1]!.hex;

    loop.receiveCommand('p-host', 'cmd-1', { kind: 'dispatchWorker', target: hostPetal });
    expect(loop.getWorld().self.bees).toHaveLength(1);
    expect(loop.getWorld().opponent.bees).toHaveLength(0);

    loop.receiveCommand('p-joiner', 'cmd-2', {
      kind: 'dispatchWorker',
      target: joinerPetal,
    });
    expect(loop.getWorld().self.bees).toHaveLength(1);
    expect(loop.getWorld().opponent.bees).toHaveLength(1);

    const acks = sent.filter((s) => s.msg.type === 'COMMAND_RESULT');
    expect(acks).toHaveLength(2);
    expect(acks.every((a) => a.msg.type === 'COMMAND_RESULT' && a.msg.ok)).toBe(true);
  });

  test('rejected commands return COMMAND_RESULT with ok=false and a reason', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    // Tile far away from any flower / freed letter — dispatchWorker should reject.
    loop.receiveCommand('p-host', 'cmd-1', {
      kind: 'dispatchWorker',
      target: hex(99, -99),
    });
    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    if (ack.msg.type !== 'COMMAND_RESULT') throw new Error('expected COMMAND_RESULT');
    expect(ack.msg.ok).toBe(false);
    expect(ack.msg.reason).toBeDefined();
  });

  test('unknown player ids are rejected', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    loop.receiveCommand('not-in-room', 'cmd-1', { kind: 'dispatchQueen' });
    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    if (ack.msg.type !== 'COMMAND_RESULT') throw new Error('expected COMMAND_RESULT');
    expect(ack.msg.ok).toBe(false);
    expect(ack.msg.reason).toMatch(/unknown player/);
  });
});

describe('gameLoop: submitWords runs server-side dictionary validation', () => {
  test('per-path WORD_RESULT flags + only the valid paths reach the engine', async () => {
    // Pre-seed a CAT path and a separate BE path on the host's tiles.
    const w0 = buildInitialWorld(makeRng(1), {
      selfId: 'p-host',
      opponentId: 'p-joiner',
    });
    const cat = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    const be = [hex(-2, 0), hex(-1, -1)] as const;
    const initialWorld: World = {
      ...w0,
      self: {
        ...w0.self,
        honey: 30,
        tiles: w0.self.tiles.map((t) => {
          if (hexEquals(t.hex, cat[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, cat[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, cat[2])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, be[0])) return { ...t, state: 'letter', letter: 'B' };
          if (hexEquals(t.hex, be[1])) return { ...t, state: 'letter', letter: 'E' };
          return t;
        }),
      },
    };
    // Dictionary mock: CAT is valid, BE is not.
    const { port, sent } = makePort(async (word) => word === 'CAT');
    const loop = createGameLoop({ players, seed: 1, initialWorld }, port);

    await loop.receiveCommand('p-host', 'cmd-submit', {
      kind: 'submitWords',
      paths: [cat, be],
    });

    const wordResult = sent.find(
      (s) => s.msg.type === 'WORD_RESULT' && s.playerId === 'p-host',
    );
    if (!wordResult || wordResult.msg.type !== 'WORD_RESULT') {
      throw new Error('expected WORD_RESULT');
    }
    expect(wordResult.msg.words).toHaveLength(2);
    expect(wordResult.msg.words[0]).toEqual({ letters: ['C', 'A', 'T'], valid: true });
    expect(wordResult.msg.words[1]).toEqual({ letters: ['B', 'E'], valid: false });

    // The engine should have a drone in flight for CAT only — the cap also
    // recorded a signature so we can simply check that capping is in motion.
    const drone = loop.getWorld().self.bees.find((b) => b.kind === 'drone');
    expect(drone).toBeDefined();

    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    if (ack.msg.type !== 'COMMAND_RESULT') throw new Error('expected COMMAND_RESULT');
    expect(ack.msg.ok).toBe(true);
  });

  test('all-invalid submit sends WORD_RESULT and a failed COMMAND_RESULT, no engine apply', async () => {
    const w0 = buildInitialWorld(makeRng(1), {
      selfId: 'p-host',
      opponentId: 'p-joiner',
    });
    const path = [hex(0, -2), hex(1, -2)] as const;
    const initialWorld: World = {
      ...w0,
      self: {
        ...w0.self,
        honey: 30,
        tiles: w0.self.tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'Z' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'Z' };
          return t;
        }),
      },
    };
    const { port, sent } = makePort(async () => false);
    const loop = createGameLoop({ players, seed: 1, initialWorld }, port);
    const honeyBefore = loop.getWorld().self.honey;
    await loop.receiveCommand('p-host', 'cmd-submit', {
      kind: 'submitWords',
      paths: [path],
    });

    const wordResult = sent.find((s) => s.msg.type === 'WORD_RESULT')!;
    if (wordResult.msg.type !== 'WORD_RESULT') throw new Error('expected WORD_RESULT');
    expect(wordResult.msg.words[0]?.valid).toBe(false);

    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    if (ack.msg.type !== 'COMMAND_RESULT') throw new Error('expected COMMAND_RESULT');
    expect(ack.msg.ok).toBe(false);
    expect(ack.msg.reason).toMatch(/no valid words/i);

    // Honey did not move — engine was never asked to apply the (would-be)
    // drone dispatch.
    expect(loop.getWorld().self.honey).toBe(honeyBefore);
  });
});

describe('gameLoop: game over', () => {
  test('engine-flagged game over → GAME_OVER reason="queen" and no further snapshots', () => {
    const w0 = buildInitialWorld(makeRng(1), {
      selfId: 'p-host',
      opponentId: 'p-joiner',
    });
    // Queen breaches are the only path that flips phase to 'over' at runtime;
    // we simulate the post-breach state by handing the loop a world that's
    // already there and letting it surface the GAME_OVER on the next tick.
    const initialWorld: World = { ...w0, phase: 'over', winner: 'self' };
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1, initialWorld }, port);
    loop.manualTick(0.05);

    const gameOvers = sent.filter((s) => s.msg.type === 'GAME_OVER');
    expect(gameOvers).toHaveLength(2);
    const first = gameOvers[0]!.msg;
    if (first.type !== 'GAME_OVER') throw new Error('expected GAME_OVER');
    expect(first.reason).toBe('queen');
    expect(first.winnerId).toBe('p-host');

    const sentLen = sent.length;
    loop.manualTick(0.05);
    expect(sent.length).toBe(sentLen);
  });

  test('forfeit → opposite side wins, GAME_OVER reason="forfeit"', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    loop.forfeit('p-host');
    const gameOvers = sent.filter((s) => s.msg.type === 'GAME_OVER');
    expect(gameOvers).toHaveLength(2);
    const msg = gameOvers[0]!.msg;
    if (msg.type !== 'GAME_OVER') throw new Error('expected GAME_OVER');
    expect(msg.reason).toBe('forfeit');
    expect(msg.winnerId).toBe('p-joiner');
  });

  test('commands after game-over are rejected', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    loop.forfeit('p-host');
    sent.length = 0;
    loop.receiveCommand('p-joiner', 'cmd-late', { kind: 'dispatchQueen' });
    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    if (ack.msg.type !== 'COMMAND_RESULT') throw new Error('expected COMMAND_RESULT');
    expect(ack.msg.ok).toBe(false);
    expect(ack.msg.reason).toMatch(/game over/);
  });
});
