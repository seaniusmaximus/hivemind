import { hex } from '@hivemind/shared';
import { useGameStore } from './gameStore.js';

describe('gameStore', () => {
  beforeEach(() => {
    useGameStore.getState().initSolo(1);
  });

  test('initSolo populates a playable world', () => {
    const { world } = useGameStore.getState();
    expect(world.self.id).toBe('self');
    expect(world.opponent.id).toBe('opponent');
    expect(world.self.hp).toBe(100);
    expect(world.patches.length).toBeGreaterThan(0);
    expect(world.self.letterQueue).toEqual([]);
    expect(world.self.carpenterQueue).toEqual([]);
  });

  test('toggleLetterQueue adds and removes a petal hex', () => {
    const petal = useGameStore.getState().world.patches[0]!.petals[0]!;
    useGameStore.getState().toggleLetterQueue(petal.hex);
    expect(useGameStore.getState().world.self.letterQueue).toHaveLength(1);
    useGameStore.getState().toggleLetterQueue(petal.hex);
    expect(useGameStore.getState().world.self.letterQueue).toHaveLength(0);
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

  test('startDraft can begin a second word path within drone capacity', () => {
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

  test('toggleCarpenterTarget queues an eligible inactive tile', () => {
    const store = useGameStore;
    store.getState().toggleCarpenterTarget(hex(3, -3));
    expect(store.getState().world.self.carpenterQueue).toHaveLength(1);
    store.getState().toggleCarpenterTarget(hex(3, -3));
    expect(store.getState().world.self.carpenterQueue).toHaveLength(0);
  });
});
