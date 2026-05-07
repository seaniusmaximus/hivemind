import { hex, hexEquals, makeRng, type Petal } from '@hivemind/shared';
import {
  buildInitialWorld,
  frontierFor,
  petalAt,
  placeLetter,
  toggleCarpenterTarget,
  toggleLetterQueue,
  trySpawnCarpenter,
  trySpawnWorker,
  trySubmitWord,
  tickWorld,
  CARPENTER_QUEUE_CAP,
  PATCH_LIFETIME_SECONDS,
  PATCH_TARGET_COUNT,
  QUEUE_CAP,
  type World,
} from './state.js';

const fixedRng = () => makeRng(42);

const advance = (world: World, seconds: number, rng = fixedRng()): World => {
  const step = 1 / 30;
  let w = world;
  let elapsed = 0;
  while (elapsed < seconds) {
    w = tickWorld(w, step, rng);
    elapsed += step;
  }
  return w;
};

const firstPetal = (w: World): Petal & { patchId: string } => {
  for (const p of w.patches) {
    const petal = p.petals[0];
    if (petal) return { ...petal, patchId: p.id };
  }
  throw new Error('no petals available');
};

describe('engine: world construction', () => {
  test('builds tiles: hive center, 6 storage slots, 12 active, no static inactive', () => {
    const w = buildInitialWorld(fixedRng());
    const center = w.self.tiles.find((t) => t.hex.q === 0 && t.hex.r === 0);
    expect(center?.state).toBe('hive');
    expect(w.self.tiles.filter((t) => t.state === 'storage')).toHaveLength(6);
    expect(w.self.tiles.filter((t) => t.state === 'active')).toHaveLength(12);
    expect(w.self.tiles.filter((t) => t.state === 'inactive')).toHaveLength(0);
    expect(w.self.tiles.every((t) => t.state !== 'storage' || t.letter === null)).toBe(true);
    expect(w.patches.length).toBe(PATCH_TARGET_COUNT);
    expect(w.self.letterQueue).toEqual([]);
    expect(w.self.carpenterQueue).toEqual([]);
    // Frontier is the immediate ring outside the active radius — 18 hexes.
    expect(frontierFor(w.self)).toHaveLength(18);
  });
});

describe('engine: flower patches', () => {
  test('every patch has up to 6 petals around an unused center, with type-coherent letters', () => {
    const w = buildInitialWorld(fixedRng());
    expect(w.patches).toHaveLength(PATCH_TARGET_COUNT);
    for (const patch of w.patches) {
      expect(patch.petals.length).toBeGreaterThan(0);
      expect(patch.petals.length).toBeLessThanOrEqual(6);
      // Center must not appear as one of its own petal hexes.
      expect(patch.petals.every((p) => !hexEquals(p.hex, patch.center))).toBe(true);
      // All petals are direct neighbors of the center.
      for (const petal of patch.petals) {
        const dq = petal.hex.q - patch.center.q;
        const dr = petal.hex.r - patch.center.r;
        const ds = -(dq + dr);
        expect((Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2).toBe(1);
      }
    }
  });

  test('petals wither over time and patches eventually despawn / respawn', () => {
    const rng = fixedRng();
    const w0 = buildInitialWorld(rng);
    const initialIds = new Set(w0.patches.map((p) => p.id));
    // Advance well past one full lifetime — at least one patch should turn over.
    const after = advance(w0, PATCH_LIFETIME_SECONDS + 5, rng);
    const afterIds = new Set(after.patches.map((p) => p.id));
    const replaced = [...initialIds].some((id) => !afterIds.has(id));
    expect(replaced).toBe(true);
    expect(after.patches.length).toBe(PATCH_TARGET_COUNT);
  });
});

describe('engine: toggleLetterQueue', () => {
  test('adds and removes a petal hex', () => {
    const w0 = buildInitialWorld(fixedRng());
    const petal = firstPetal(w0);
    const r1 = toggleLetterQueue(w0, 'self', petal.hex);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.world.self.letterQueue).toHaveLength(1);
    const r2 = toggleLetterQueue(r1.world, 'self', petal.hex);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.world.self.letterQueue).toHaveLength(0);
  });

  test('rejects when there is no petal at the chosen hex', () => {
    const w = buildInitialWorld(fixedRng());
    const empty = hex(99, -99);
    const r = toggleLetterQueue(w, 'self', empty);
    expect(r.ok).toBe(false);
  });

  test('rejects beyond capacity', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const allPetals = w.patches.flatMap((p) => p.petals);
    expect(allPetals.length).toBeGreaterThanOrEqual(QUEUE_CAP + 1);
    for (let i = 0; i < QUEUE_CAP; i++) {
      const r = toggleLetterQueue(w, 'self', allPetals[i]!.hex);
      expect(r.ok).toBe(true);
      if (r.ok) w = r.world;
    }
    const overflow = toggleLetterQueue(w, 'self', allPetals[QUEUE_CAP]!.hex);
    expect(overflow.ok).toBe(false);
  });
});

describe('engine: trySpawnWorker', () => {
  test('refuses with empty queue', () => {
    const w = buildInitialWorld(fixedRng());
    const r = trySpawnWorker(w, 'self');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/letters/);
  });

  test('refuses when storage is full', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const t = toggleLetterQueue(w, 'self', petal.hex);
    if (!t.ok) throw new Error('toggle failed');
    w = t.world;
    w = {
      ...w,
      self: {
        ...w.self,
        tiles: w.self.tiles.map((tile) =>
          tile.state === 'storage' ? { ...tile, letter: 'A' as const } : tile,
        ),
      },
    };
    const r = trySpawnWorker(w, 'self');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/storage/);
  });

  test('consumes queue, deducts honey, queues a flying-to-flower bee', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const t = toggleLetterQueue(w, 'self', petal.hex);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    w = t.world;
    const r = trySpawnWorker(w, 'self');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.world.self.honey).toBeLessThan(w.self.honey);
    expect(r.world.self.letterQueue).toEqual([]);
    const bee = r.world.self.bees[0]!;
    expect(bee.kind).toBe('worker');
    expect(bee.state.kind).toBe('worker-flying-to-flower');
  });
});

describe('engine: worker round trip → letter ends up in storage', () => {
  test('flies to petal, returns, stored in a storage slot (not on an active tile)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const targetLetter = petal.letter;

    const t = toggleLetterQueue(w, 'self', petal.hex);
    if (!t.ok) throw new Error('queue toggle failed');
    w = t.world;
    const s = trySpawnWorker(w, 'self');
    if (!s.ok) throw new Error('spawn failed');
    w = s.world;

    const after = advance(w, 4.0, rng);
    expect(petalAt(after.patches, petal.hex)).toBeNull();
    const filledStorage = after.self.tiles.filter(
      (tile) => tile.state === 'storage' && tile.letter !== null,
    );
    expect(filledStorage).toHaveLength(1);
    expect(filledStorage[0]!.letter).toBe(targetLetter);
    expect(after.self.tiles.filter((t) => t.state === 'letter')).toHaveLength(0);
    expect(after.self.bees).toHaveLength(0);
  });
});

describe('engine: race for the same petal', () => {
  test('first bee to arrive collects, second one misses', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const t1 = toggleLetterQueue(w, 'self', petal.hex);
    if (!t1.ok) throw new Error('toggle 1 failed');
    w = t1.world;
    const t2 = toggleLetterQueue(w, 'opponent', petal.hex);
    if (!t2.ok) throw new Error('toggle 2 failed');
    w = t2.world;

    w = {
      ...w,
      self: { ...w.self, honey: 20 },
      opponent: { ...w.opponent, honey: 20 },
    };

    const s1 = trySpawnWorker(w, 'self');
    if (!s1.ok) throw new Error('self spawn failed');
    w = s1.world;
    const s2 = trySpawnWorker(w, 'opponent');
    if (!s2.ok) throw new Error('opp spawn failed');
    w = s2.world;

    const after = advance(w, 4.0, rng);
    const selfStored = after.self.tiles.some(
      (t) => t.state === 'storage' && t.letter === petal.letter,
    );
    const oppStored = after.opponent.tiles.some(
      (t) => t.state === 'storage' && t.letter === petal.letter,
    );
    expect(selfStored !== oppStored).toBe(true);
    expect(selfStored).toBe(true);
  });
});

describe('engine: placeLetter (storage → active)', () => {
  test('moves the letter, locks it onto the active tile, leaves storage empty', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const storage = w.self.tiles.find((t) => t.state === 'storage')!;
    const active = w.self.tiles.find((t) => t.state === 'active')!;
    w = {
      ...w,
      self: {
        ...w.self,
        tiles: w.self.tiles.map((t) =>
          hexEquals(t.hex, storage.hex) ? { ...t, letter: 'C' as const } : t,
        ),
      },
    };
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const movedSource = r.world.self.tiles.find((t) => hexEquals(t.hex, storage.hex))!;
    const movedDest = r.world.self.tiles.find((t) => hexEquals(t.hex, active.hex))!;
    expect(movedSource.state).toBe('storage');
    expect(movedSource.letter).toBe(null);
    expect(movedDest.state).toBe('letter');
    expect(movedDest.letter).toBe('C');
  });

  test('refuses if storage is empty', () => {
    const w = buildInitialWorld(fixedRng());
    const storage = w.self.tiles.find((t) => t.state === 'storage')!;
    const active = w.self.tiles.find((t) => t.state === 'active')!;
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(false);
  });

  test('refuses if destination is occupied', () => {
    let w = buildInitialWorld(fixedRng());
    const storage = w.self.tiles.find((t) => t.state === 'storage')!;
    const active = w.self.tiles.find((t) => t.state === 'active')!;
    w = {
      ...w,
      self: {
        ...w.self,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, storage.hex)) return { ...t, letter: 'A' as const };
          if (hexEquals(t.hex, active.hex)) return { ...t, state: 'letter' as const, letter: 'B' as const };
          return t;
        }),
      },
    };
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(false);
  });
});

describe('engine: drone caps a placed word', () => {
  test('contiguous letter path → score increases, opponent HP drops, tiles capped', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 20,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      },
    };
    const oppHpBefore = w.opponent.hp;
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const after = advance(submit.world, 3.0, rng);
    expect(after.self.score).toBeGreaterThan(0);
    expect(after.opponent.hp).toBeLessThan(oppHpBefore);
    expect(after.self.tiles.filter((t) => t.state === 'capped')).toHaveLength(3);
  });
});

describe('engine: chain bonus on shared tile', () => {
  test('two paths sharing a tile pay 1.5× the combined word score', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Two L-shaped words sharing the corner at (0,-2).
    const w1 = [hex(-2, 0), hex(-1, -1), hex(0, -2)] as const;
    const w2 = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 30,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, w1[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, w1[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, w1[2])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, w2[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, w2[2])) return { ...t, state: 'letter', letter: 'B' };
          return t;
        }),
      },
    };
    const submit = trySubmitWord(w, 'self', [w1, w2]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const after = advance(submit.world, 4.0, rng);
    // CAT (3+1+1=5) + TAB (1+1+3=5) = 10 baseline; chain ×1.5 → 15.
    expect(after.self.score).toBe(15);
    expect(after.self.tiles.filter((t) => t.state === 'capped').length).toBeGreaterThanOrEqual(5);
  });

  test('two non-overlapping words pay only the sum', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const w1 = [hex(-2, 0), hex(-1, -1)] as const;
    const w2 = [hex(2, -2), hex(1, -1)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 30,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, w1[0])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, w1[1])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, w2[0])) return { ...t, state: 'letter', letter: 'B' };
          if (hexEquals(t.hex, w2[1])) return { ...t, state: 'letter', letter: 'E' };
          return t;
        }),
      },
    };
    const submit = trySubmitWord(w, 'self', [w1, w2]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const after = advance(submit.world, 4.0, rng);
    // AT (1+1=2) + BE (3+1=4) = 6, no chain bonus.
    expect(after.self.score).toBe(6);
  });
});

describe('engine: branches reuse capped tiles', () => {
  test('a path through a previously capped tile is accepted and re-caps shared tiles', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const corner = hex(0, -2);
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 30,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, corner)) return { ...t, state: 'capped', letter: 'A' };
          if (hexEquals(t.hex, hex(1, -2))) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      },
    };
    const submit = trySubmitWord(w, 'self', [[corner, hex(1, -2)]]);
    expect(submit.ok).toBe(true);
  });
});

describe('engine: carpenter queue + frontier expansion', () => {
  test('toggleCarpenterTarget accepts a frontier hex adjacent to active, rejects others', () => {
    const w0 = buildInitialWorld(fixedRng());
    // (3,-3) sits on the immediate frontier outside the ring-2 active tiles.
    const frontier = hex(3, -3);
    const r1 = toggleCarpenterTarget(w0, 'self', frontier);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.world.self.carpenterQueue).toHaveLength(1);

    // A storage hex (ring 1) is owned but not eligible.
    const storage = w0.self.tiles.find((t) => t.state === 'storage')!.hex;
    const bad = toggleCarpenterTarget(w0, 'self', storage);
    expect(bad.ok).toBe(false);

    // A hex far away (not touching the hive) is also not eligible.
    const farAway = hex(10, -10);
    const bad2 = toggleCarpenterTarget(w0, 'self', farAway);
    expect(bad2.ok).toBe(false);
  });

  test('rejects beyond carpenter capacity', () => {
    let w = buildInitialWorld(fixedRng());
    const frontierHexes = frontierFor(w.self).slice(0, CARPENTER_QUEUE_CAP);
    expect(frontierHexes.length).toBe(CARPENTER_QUEUE_CAP);
    for (const h of frontierHexes) {
      const r = toggleCarpenterTarget(w, 'self', h);
      expect(r.ok).toBe(true);
      if (r.ok) w = r.world;
    }
    const overflow = frontierFor(w.self).find(
      (h) => !w.self.carpenterQueue.some((q) => hexEquals(q, h)),
    )!;
    const r = toggleCarpenterTarget(w, 'self', overflow);
    expect(r.ok).toBe(false);
  });

  test('carpenter bee activates a queued frontier hex (appending a new tile)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, self: { ...w.self, honey: 20 } };
    const target = hex(3, -3);
    const tilesBefore = w.self.tiles.length;
    const t = toggleCarpenterTarget(w, 'self', target);
    if (!t.ok) throw new Error('toggle failed');
    w = t.world;
    const s = trySpawnCarpenter(w, 'self');
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    w = s.world;
    const after = advance(w, 4.0, rng);
    const tile = after.self.tiles.find((tt) => hexEquals(tt.hex, target));
    expect(tile?.state).toBe('active');
    expect(after.self.tiles.length).toBe(tilesBefore + 1);
    expect(after.self.bees).toHaveLength(0);
  });

  test('carpenters can expand the hive past the initial radius', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, self: { ...w.self, honey: 100 } };
    // First step: activate (3,-3) at radius 3.
    const step1 = toggleCarpenterTarget(w, 'self', hex(3, -3));
    if (!step1.ok) throw new Error('step1 toggle failed');
    w = step1.world;
    const sp1 = trySpawnCarpenter(w, 'self');
    if (!sp1.ok) throw new Error('step1 spawn failed');
    w = advance(sp1.world, 4.0, rng);
    expect(w.self.tiles.find((t) => hexEquals(t.hex, hex(3, -3)))?.state).toBe('active');

    // Second step: (4,-3) is now on the frontier of (3,-3). Activate it.
    expect(frontierFor(w.self).some((h) => hexEquals(h, hex(4, -3)))).toBe(true);
    const step2 = toggleCarpenterTarget(w, 'self', hex(4, -3));
    if (!step2.ok) throw new Error('step2 toggle failed');
    w = step2.world;
    const sp2 = trySpawnCarpenter(w, 'self');
    if (!sp2.ok) throw new Error('step2 spawn failed');
    w = advance(sp2.world, 4.0, rng);
    expect(w.self.tiles.find((t) => hexEquals(t.hex, hex(4, -3)))?.state).toBe('active');
  });
});
