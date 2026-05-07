import {
  buildInitialWorld,
  hex,
  makeRng,
  worldToSnapshot,
  type ClientMessage,
} from '@hivemind/shared';
import type { NetConnection } from '../game/net/connection.js';
import { useGameStore } from './gameStore.js';

describe('gameStore', () => {
  beforeEach(() => {
    useGameStore.getState().initSolo(1);
  });

  test('initSolo populates a playable world', () => {
    const { world } = useGameStore.getState();
    expect(world.self.id).toBe('self');
    expect(world.opponent.id).toBe('opponent');
    // Honey is the only resource; both sides start with the configured stash.
    expect(world.self.honey).toBeGreaterThan(0);
    expect(world.opponent.honey).toBeGreaterThan(0);
    expect(world.patches.length).toBeGreaterThan(0);
    expect(world.self.bees).toEqual([]);
  });

  test('dispatchWorker spawns a single-trip worker bee aimed at the petal', () => {
    const store = useGameStore;
    const petal = store.getState().world.patches[0]!.petals[0]!;
    store.getState().dispatchWorker(petal.hex);
    const w = store.getState().world;
    expect(w.self.bees).toHaveLength(1);
    const bee = w.self.bees[0]!;
    expect(bee.kind).toBe('worker');
    expect(bee.state.kind).toBe('worker-flying-to-flower');
    if (bee.state.kind === 'worker-flying-to-flower') {
      expect(bee.state.target).toEqual(petal.hex);
      expect(bee.state.queue).toEqual([]);
    }
    expect(store.getState().lastError).toBeNull();
  });

  test('dispatchWorker reports an error when honey is short', () => {
    const store = useGameStore;
    store.setState((s) => ({ world: { ...s.world, self: { ...s.world.self, honey: 0 } } }));
    const petal = store.getState().world.patches[0]!.petals[0]!;
    store.getState().dispatchWorker(petal.hex);
    expect(store.getState().world.self.bees).toHaveLength(0);
    expect(store.getState().lastError).toMatch(/honey/);
  });

  test('dispatchCarpenter spawns a carpenter bee at a frontier hex', () => {
    const store = useGameStore;
    store.getState().dispatchCarpenter(hex(3, -3));
    const w = store.getState().world;
    expect(w.self.bees).toHaveLength(1);
    const bee = w.self.bees[0]!;
    expect(bee.kind).toBe('carpenter');
    expect(bee.state.kind).toBe('carpenter-flying');
    if (bee.state.kind === 'carpenter-flying') {
      expect(bee.state.target).toEqual(hex(3, -3));
      expect(bee.state.queue).toEqual([]);
    }
  });

  test('dispatchCarpenter rejects hexes that do not touch the hive', () => {
    const store = useGameStore;
    store.getState().dispatchCarpenter(hex(20, -20));
    expect(store.getState().world.self.bees).toHaveLength(0);
    expect(store.getState().lastError).toMatch(/hive|touch/i);
  });

  test('startDraft is rejected when starting on a non-letter tile (e.g. the hive)', () => {
    useGameStore.getState().startDraft(hex(0, 0));
    expect(useGameStore.getState().wordDrafts).toHaveLength(0);
  });

  test('startLetterDrag is rejected on empty storage; succeeds on filled', () => {
    const store = useGameStore;
    const storage = store.getState().world.self.tiles.find((t) => t.state === 'storage')!;
    store.getState().startLetterDrag(storage.hex);
    expect(store.getState().letterDrag).toBeNull();
    store.setState((s) => ({
      world: {
        ...s.world,
        self: {
          ...s.world.self,
          tiles: s.world.self.tiles.map((t) =>
            t.hex.q === storage.hex.q && t.hex.r === storage.hex.r
              ? { ...t, letter: 'A' as const }
              : t,
          ),
        },
      },
    }));
    store.getState().startLetterDrag(storage.hex);
    expect(store.getState().letterDrag?.letter).toBe('A');
  });

  test('extendDraft adds adjacent ring-2 letter tiles and backtracks', () => {
    const store = useGameStore;
    store.setState((s) => ({
      world: {
        ...s.world,
        self: {
          ...s.world.self,
          tiles: s.world.self.tiles.map((t) => {
            if (t.hex.q === 0 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'C' };
            if (t.hex.q === 1 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'A' };
            if (t.hex.q === 2 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'T' };
            return t;
          }),
        },
      },
    }));
    store.getState().startDraft(hex(0, -2));
    store.getState().extendDraft(hex(1, -2));
    store.getState().extendDraft(hex(2, -2));
    expect(store.getState().wordDrafts[0]).toHaveLength(3);
    store.getState().extendDraft(hex(1, -2));
    expect(store.getState().wordDrafts[0]).toHaveLength(2);
  });

  test('startDraft can begin multiple word paths', () => {
    const store = useGameStore;
    store.setState((s) => ({
      world: {
        ...s.world,
        self: {
          ...s.world.self,
          tiles: s.world.self.tiles.map((t) => {
            if (t.hex.q === 0 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'C' };
            if (t.hex.q === 1 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'A' };
            if (t.hex.q === 2 && t.hex.r === -2) return { ...t, state: 'letter', letter: 'T' };
            if (t.hex.q === -2 && t.hex.r === 0) return { ...t, state: 'letter', letter: 'B' };
            if (t.hex.q === -1 && t.hex.r === 0) return { ...t, state: 'letter', letter: 'E' };
            return t;
          }),
        },
      },
    }));
    store.getState().startDraft(hex(0, -2));
    store.getState().extendDraft(hex(1, -2));
    store.getState().endDraft();
    store.getState().startDraft(hex(-2, 0));
    store.getState().extendDraft(hex(-1, 0));
    expect(store.getState().wordDrafts).toHaveLength(2);
  });
});

describe('gameStore — net slice', () => {
  /** Build a fresh fake connection that just records every message sent. */
  const makeFakeConn = (): { conn: NetConnection; sent: ClientMessage[] } => {
    const sent: ClientMessage[] = [];
    return {
      sent,
      conn: {
        send: (msg: ClientMessage) => sent.push(msg),
        close: () => {},
      },
    };
  };

  beforeEach(() => {
    // Wipe any leftover net state from a prior test, then return to a fresh
    // solo world so each scenario starts identically.
    useGameStore.getState()._setConnection(null);
    useGameStore.setState({ room: null });
    useGameStore.getState().initSolo(1);
  });

  test('_setConnection flips the store into lobby mode', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    const s = useGameStore.getState();
    expect(s.mode).toBe('lobby');
    expect(s.net.status).toBe('open');
    expect(s.room).toBeNull();
  });

  test('ROOM_STATE populates room with code, players, and phase', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'ROOM_STATE',
      roomCode: 'ABC123',
      phase: 'lobby',
      players: [
        { id: 'p1', name: 'host', ready: false },
        { id: 'p2', name: 'guest', ready: true },
      ],
    });
    const room = useGameStore.getState().room!;
    expect(room.code).toBe('ABC123');
    expect(room.phase).toBe('lobby');
    expect(room.players.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  test('GAME_START switches to online mode and stores selfId/opponentId', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'ROOM_STATE',
      roomCode: 'ABC123',
      phase: 'countdown',
      players: [
        { id: 'p1', name: 'host', ready: true },
        { id: 'p2', name: 'guest', ready: true },
      ],
    });
    useGameStore.getState()._handleServerMessage({
      type: 'GAME_START',
      selfId: 'p1',
      opponentId: 'p2',
      seed: 42,
      tickRate: 15,
      startedAt: 0,
    });
    const s = useGameStore.getState();
    expect(s.mode).toBe('online');
    expect(s.room?.selfId).toBe('p1');
    expect(s.room?.opponentId).toBe('p2');
    expect(s.room?.phase).toBe('playing');
  });

  test('SNAPSHOT replaces the world (engine time and players)', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);

    // Build an authoritative-looking world we can project as a snapshot.
    const authoritative = buildInitialWorld(makeRng(99), { selfId: 'p1', opponentId: 'p2' });
    const advanced = { ...authoritative, t: 12.5 };
    const snap = worldToSnapshot(advanced, 'self', 7);

    useGameStore.getState()._handleServerMessage({ type: 'SNAPSHOT', tick: 7, world: snap });
    const w = useGameStore.getState().world;
    expect(w.t).toBeCloseTo(12.5, 5);
    expect(w.self.id).toBe('p1');
    expect(w.opponent.id).toBe('p2');
  });

  test('applyCommand in online mode forwards a COMMAND over the wire', () => {
    const { conn, sent } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'GAME_START',
      selfId: 'p1',
      opponentId: 'p2',
      seed: 1,
      tickRate: 15,
      startedAt: 0,
    });
    const petal = useGameStore.getState().world.patches[0]!.petals[0]!;
    useGameStore.getState().applyCommand({ kind: 'dispatchWorker', target: petal.hex }, 'self');

    const lastSent = sent[sent.length - 1]!;
    expect(lastSent.type).toBe('COMMAND');
    if (lastSent.type === 'COMMAND') {
      expect(lastSent.cmd).toEqual({ kind: 'dispatchWorker', target: petal.hex });
      expect(typeof lastSent.commandId).toBe('string');
    }
  });

  test('applyCommand in solo mode never touches the wire', () => {
    const { conn, sent } = makeFakeConn();
    // Connect but stay in lobby/solo — no GAME_START fired.
    useGameStore.getState()._setConnection(conn);
    useGameStore.setState({ mode: 'solo' });

    const petal = useGameStore.getState().world.patches[0]!.petals[0]!;
    useGameStore.getState().applyCommand({ kind: 'dispatchWorker', target: petal.hex }, 'self');
    expect(sent).toHaveLength(0);
  });

  test('tick advances the world locally in online mode (snapshots reconcile)', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'GAME_START',
      selfId: 'p1',
      opponentId: 'p2',
      seed: 1,
      tickRate: 15,
      startedAt: 0,
    });
    const before = useGameStore.getState().world.t;
    useGameStore.getState().tick(1);
    // Local prediction advances world.t; the next SNAPSHOT will overwrite it
    // with the server's authoritative time. We just need *some* progress so
    // bee animations don't stall between snapshots.
    expect(useGameStore.getState().world.t).toBeGreaterThan(before);
  });

  test('tick in online mode does NOT run the solo AI (no opponent bees spawn)', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'GAME_START',
      selfId: 'p1',
      opponentId: 'p2',
      seed: 1,
      tickRate: 15,
      startedAt: 0,
    });
    expect(useGameStore.getState().world.opponent.bees).toHaveLength(0);
    // Ten generous seconds of simulated time — far more than the dummy AI
    // worker cooldown. In solo mode this would have produced opponent bees.
    for (let i = 0; i < 100; i++) useGameStore.getState().tick(0.1);
    expect(useGameStore.getState().world.opponent.bees).toHaveLength(0);
  });

  test('COMMAND_RESULT { ok: false } surfaces a toast with the reason', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'COMMAND_RESULT',
      commandId: 'c1',
      ok: false,
      reason: 'not enough honey',
    });
    const toasts = useGameStore.getState().toasts;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[toasts.length - 1]!.text).toMatch(/honey/);
  });

  test('WORD_RESULT with invalid words surfaces a "skipped" toast', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'WORD_RESULT',
      ownerId: 'p1',
      words: [
        { letters: ['C', 'A', 'T'], valid: true },
        { letters: ['X', 'Q', 'Z'], valid: false },
      ],
    });
    const toasts = useGameStore.getState().toasts;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[toasts.length - 1]!.text.toLowerCase()).toContain('xqz');
  });

  test('GAME_OVER fills the room result with winnerId + reason', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'ROOM_STATE',
      roomCode: 'ABC123',
      phase: 'playing',
      players: [
        { id: 'p1', name: 'host', ready: true },
        { id: 'p2', name: 'guest', ready: true },
      ],
    });
    useGameStore.getState()._handleServerMessage({
      type: 'GAME_OVER',
      winnerId: 'p2',
      reason: 'queen',
    });
    expect(useGameStore.getState().room?.result).toEqual({
      winnerId: 'p2',
      reason: 'queen',
    });
    expect(useGameStore.getState().room?.phase).toBe('over');
  });

  test('ERROR with NO_ROOM resets room and surfaces the message', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'ROOM_STATE',
      roomCode: 'ABC123',
      phase: 'lobby',
      players: [{ id: 'p1', name: 'host', ready: false }],
    });
    useGameStore.getState()._handleServerMessage({
      type: 'ERROR',
      code: 'NO_ROOM',
      message: 'room not found',
    });
    expect(useGameStore.getState().room).toBeNull();
    expect(useGameStore.getState().net.lastError).toMatch(/room not found/);
  });

  test('createRoom / joinRoom / sendReady forward typed messages', () => {
    const { conn, sent } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState().createRoom('alice');
    useGameStore.getState().joinRoom('ABC123', 'bob');
    useGameStore.getState().sendReady();
    expect(sent).toEqual([
      { type: 'CREATE_ROOM', playerName: 'alice' },
      { type: 'JOIN_ROOM', roomCode: 'ABC123', playerName: 'bob' },
      { type: 'READY' },
    ]);
  });

  test('leaveLobby tears down state and re-inits a fresh solo world', () => {
    const { conn } = makeFakeConn();
    useGameStore.getState()._setConnection(conn);
    useGameStore.getState()._handleServerMessage({
      type: 'ROOM_STATE',
      roomCode: 'ABC123',
      phase: 'lobby',
      players: [{ id: 'p1', name: 'host', ready: false }],
    });
    useGameStore.getState().leaveLobby();
    const s = useGameStore.getState();
    expect(s.mode).toBe('solo');
    expect(s.room).toBeNull();
    expect(s.net.status).toBe('idle');
    // Sanity-check that the world is freshly initialised.
    expect(s.world.self.id).toBe('self');
    expect(s.world.opponent.id).toBe('opponent');
  });
});
