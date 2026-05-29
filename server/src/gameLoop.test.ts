import {
  buildInitialWorld,
  getPlayer,
  hex,
  hexEquals,
  makeRng,
  setPlayerById,
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

const players = [{ id: 'p-host' }, { id: 'p-joiner' }] as const;

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
    for (let i = 0; i < 5; i++) loop.manualTick(1 / 30);
    expect(sent.filter((s) => s.msg.type === 'SNAPSHOT')).toHaveLength(0);
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
    const initialWorld: World = setPlayerById(
      setPlayerById(w0, 'p-host', { ...getPlayer(w0, 'p-host'), honey: 17 }),
      'p-joiner',
      { ...getPlayer(w0, 'p-joiner'), honey: 4 },
    );
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
    expect(hostSnap.msg.world.self.honey).toBeGreaterThanOrEqual(17);
    expect(hostSnap.msg.world.opponents[0]!.honey).toBeGreaterThanOrEqual(4);
    expect(hostSnap.msg.world.self.honey).toBeGreaterThan(
      hostSnap.msg.world.opponents[0]!.honey,
    );
    expect(hostSnap.msg.world.self.honey).toBe(joinerSnap.msg.world.opponents[0]!.honey);
    expect(hostSnap.msg.world.opponents[0]!.honey).toBe(joinerSnap.msg.world.self.honey);
  });
});

describe('gameLoop: command routing', () => {
  test('host commands modify host player; joiner commands modify joiner player', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    const w0 = loop.getWorld();
    const hostPetal = w0.patches[0]!.petals[0]!.hex;
    const joinerPetal = w0.patches[0]!.petals[1]!.hex;

    void loop.receiveCommand('p-host', 'cmd-1', { kind: 'dispatchWorker', target: hostPetal });
    expect(getPlayer(loop.getWorld(), 'p-host').bees).toHaveLength(1);
    expect(getPlayer(loop.getWorld(), 'p-joiner').bees).toHaveLength(0);

    void loop.receiveCommand('p-joiner', 'cmd-2', {
      kind: 'dispatchWorker',
      target: joinerPetal,
    });
    expect(getPlayer(loop.getWorld(), 'p-host').bees).toHaveLength(1);
    expect(getPlayer(loop.getWorld(), 'p-joiner').bees).toHaveLength(1);

    const acks = sent.filter((s) => s.msg.type === 'COMMAND_RESULT');
    expect(acks).toHaveLength(2);
    expect(acks.every((a) => a.msg.type === 'COMMAND_RESULT' && a.msg.ok)).toBe(true);
  });

  test('rejected commands return COMMAND_RESULT with ok=false and a reason', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    void loop.receiveCommand('p-host', 'bad', {
      kind: 'dispatchWorker',
      target: hex(99, 99),
    });
    const ack = sent.find((s) => s.msg.type === 'COMMAND_RESULT')!;
    expect(ack.msg.type).toBe('COMMAND_RESULT');
    if (ack.msg.type === 'COMMAND_RESULT') {
      expect(ack.msg.ok).toBe(false);
      expect(ack.msg.reason).toBeTruthy();
    }
  });
});

describe('gameLoop: forfeit', () => {
  test('forfeit eliminates player; survivor wins when one remains', () => {
    const { port, sent } = makePort();
    const loop = createGameLoop({ players, seed: 1 }, port);
    loop.forfeit('p-joiner');
    expect(loop.getWorld().phase).toBe('over');
    expect(loop.getWorld().winnerId).toBe('p-host');
    const over = sent.find((s) => s.msg.type === 'GAME_OVER');
    expect(over?.msg.type).toBe('GAME_OVER');
    if (over?.msg.type === 'GAME_OVER') {
      expect(over.msg.winnerId).toBe('p-host');
      expect(over.msg.reason).toBe('forfeit');
    }
  });
});
