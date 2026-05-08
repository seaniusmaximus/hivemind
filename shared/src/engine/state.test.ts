import { hex, hexEquals } from '../hex.js';
import { HIVE } from '../bees.js';
import { makeRng } from '../letters.js';
import type { Petal } from '../messages.js';
import {
  applyCommand,
  buildInitialWorld,
  dispatchCarpenter,
  dispatchWorker,
  frontierFor,
  honeyCapFor,
  honeyRateFor,
  petalAt,
  placeLetter,
  trySubmitWord,
  tickWorld,
  worldToSnapshot,
  PATCH_LIFETIME_SECONDS,
  PATCH_TARGET_COUNT,
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
    expect(w.self.bees).toEqual([]);
    // Frontier is the immediate ring outside the active radius — 18 hexes.
    expect(frontierFor(w.self)).toHaveLength(18);
  });
});

describe('engine: honey economy', () => {
  test('regen rate scales linearly with owned hex count', () => {
    const w = buildInitialWorld(fixedRng());
    const expected = HIVE.regenPerHex * w.self.tiles.length;
    expect(honeyRateFor(w.self)).toBeCloseTo(expected);
    expect(honeyRateFor(w.opponent)).toBeCloseTo(expected);
  });

  test('cap formula = hiveStorage + count(non-storage non-hive tiles)', () => {
    const w = buildInitialWorld(fixedRng());
    const honeycomb = w.self.tiles.filter(
      (t) => t.state !== 'storage' && t.state !== 'hive',
    ).length;
    expect(honeycomb).toBe(12);
    expect(honeyCapFor(w.self)).toBe(HIVE.hiveStorage + honeycomb);
  });

  test('placing a letter (active → letter) does not change the cap', () => {
    const w0 = buildInitialWorld(fixedRng());
    const before = honeyCapFor(w0.self);
    const target = w0.self.tiles.find((t) => t.state === 'active')!;
    const w1: World = {
      ...w0,
      self: {
        ...w0.self,
        tiles: w0.self.tiles.map((t) =>
          hexEquals(t.hex, target.hex) ? { ...t, state: 'letter', letter: 'A' } : t,
        ),
      },
    };
    expect(honeyCapFor(w1.self)).toBe(before);
  });

  test('passive regen accrues over time, clamped at the per-player cap', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Burn the starting honey down so regen has room.
    w = { ...w, self: { ...w.self, honey: 0 }, opponent: { ...w.opponent, honey: 0 } };
    const after = advance(w, 4.0, rng);
    // Linear projection bounded by the cap — works for any `regenPerHex`
    // setting (designers retune it freely).
    const projected = honeyRateFor(w.self) * 4.0;
    const expected = Math.min(projected, honeyCapFor(w.self));
    expect(after.self.honey).toBeGreaterThan(expected - 0.5);
    expect(after.self.honey).toBeLessThanOrEqual(honeyCapFor(after.self) + 1e-6);
  });

  test('honey at cap will not exceed the cap on further ticks', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const cap = honeyCapFor(w.self);
    w = { ...w, self: { ...w.self, honey: cap } };
    const after = advance(w, 2.0, rng);
    expect(after.self.honey).toBeLessThanOrEqual(honeyCapFor(after.self) + 1e-6);
  });
});

describe('engine: no time-based victory', () => {
  test('long simulations leave phase === "playing" when nobody breaches', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = {
      ...w,
      t: 10 * 60,
      self: { ...w.self, honey: 50 },
      opponent: { ...w.opponent, honey: 5 },
    };
    const after = tickWorld(w, 0.05, rng);
    expect(after.phase).toBe('playing');
    expect(after.winner).toBeNull();
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

  test('initial spawn always has exactly one vowel, one common, one rare', () => {
    // Try several seeds so we know the invariant is structural, not a fluke
    // of one RNG path.
    for (const seed of [1, 7, 42, 1234, 99999]) {
      const w = buildInitialWorld(makeRng(seed));
      const types = w.patches.map((p) => p.type).sort();
      expect(types).toEqual(['common', 'rare', 'vowel']);
    }
  });

  test('field maintains 1-of-each-type across full lifetime turnover', () => {
    const rng = makeRng(7);
    let w = buildInitialWorld(rng);
    // Sample the field type distribution at many points across two full
    // lifetimes — every sample should have exactly one of each type.
    const samples = 24;
    for (let i = 0; i < samples; i++) {
      w = advance(w, (PATCH_LIFETIME_SECONDS * 2) / samples, rng);
      // Patches may briefly drop below 3 during the respawn cooldown; when
      // the count is full, every type must be represented.
      if (w.patches.length === 3) {
        const types = w.patches.map((p) => p.type).sort();
        expect(types).toEqual(['common', 'rare', 'vowel']);
      } else {
        // Even mid-cooldown, no two patches of the same type should exist.
        const types = w.patches.map((p) => p.type);
        expect(new Set(types).size).toBe(types.length);
      }
    }
  });
});

describe('engine: dispatchWorker', () => {
  test('rejects when the target hex has no petal', () => {
    const w = buildInitialWorld(fixedRng());
    const empty = hex(99, -99);
    const r = dispatchWorker(w, 'self', empty);
    expect(r.ok).toBe(false);
  });

  test('rejects when storage is full', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = {
      ...w,
      self: {
        ...w.self,
        tiles: w.self.tiles.map((tile) =>
          tile.state === 'storage' ? { ...tile, letter: 'A' as const } : tile,
        ),
      },
    };
    const petal = firstPetal(w);
    const r = dispatchWorker(w, 'self', petal.hex);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/storage/);
  });

  test('rejects when the player cannot afford a worker', () => {
    const w0 = buildInitialWorld(fixedRng());
    const w = { ...w0, self: { ...w0.self, honey: 0 } };
    const petal = firstPetal(w);
    const r = dispatchWorker(w, 'self', petal.hex);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/honey/);
  });

  test('deducts honey and queues a single-trip flying-to-flower bee', () => {
    const rng = fixedRng();
    const w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const r = dispatchWorker(w, 'self', petal.hex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.world.self.honey).toBeLessThan(w.self.honey);
    const bee = r.world.self.bees[0]!;
    expect(bee.kind).toBe('worker');
    expect(bee.state.kind).toBe('worker-flying-to-flower');
    if (bee.state.kind === 'worker-flying-to-flower') {
      expect(bee.state.target).toEqual(petal.hex);
      expect(bee.state.queue).toEqual([]);
    }
  });
});

describe('engine: worker round trip → letter ends up in storage', () => {
  test('flies to petal, returns, stored in a storage slot (not on an active tile)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);
    const targetLetter = petal.letter;

    const r = dispatchWorker(w, 'self', petal.hex);
    if (!r.ok) throw new Error('dispatch failed');
    w = r.world;

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

    w = {
      ...w,
      self: { ...w.self, honey: 20 },
      opponent: { ...w.opponent, honey: 20 },
    };

    const s1 = dispatchWorker(w, 'self', petal.hex);
    if (!s1.ok) throw new Error('self spawn failed');
    w = s1.world;
    const s2 = dispatchWorker(w, 'opponent', petal.hex);
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

describe('engine: placeLetter (storage ↔ comb)', () => {
  test('moves the letter onto the comb as active+letter, leaves storage empty', () => {
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
    expect(movedDest.state).toBe('active');
    expect(movedDest.letter).toBe('C');
  });

  test('can move an uncapped comb letter back into empty storage', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const storage = w.self.tiles.find((t) => t.state === 'storage' && !t.letter)!;
    const active = w.self.tiles.find((t) => t.state === 'active')!;
    w = {
      ...w,
      self: {
        ...w.self,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, active.hex)) return { ...t, state: 'active' as const, letter: 'Z' as const };
          return t;
        }),
      },
    };
    const r = placeLetter(w, 'self', active.hex, storage.hex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.world.self.tiles.find((t) => hexEquals(t.hex, active.hex))!;
    const dest = r.world.self.tiles.find((t) => hexEquals(t.hex, storage.hex))!;
    expect(src.letter).toBe(null);
    expect(dest.letter).toBe('Z');
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
          if (hexEquals(t.hex, active.hex)) return { ...t, state: 'active' as const, letter: 'B' as const };
          return t;
        }),
      },
    };
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(false);
  });
});

describe('engine: drone caps a placed word', () => {
  test('contiguous letter path → honey awarded, tiles capped, opponent untouched', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        // Low starting honey so the +5 bonus isn't clipped by the cap.
        honey: 8,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      },
    };
    const oppHoneyBefore = w.opponent.honey;
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    // Drone caps are free; honey is unchanged at submit time.
    expect(submit.world.self.honey).toBe(8);
    const after = advance(submit.world, 3.0, rng);
    // CAT scores 5; bonus + a sliver of regen should leave us above the
    // pre-submit baseline.
    expect(after.self.honey).toBeGreaterThan(12);
    expect(after.self.tiles.filter((t) => t.state === 'capped')).toHaveLength(3);
    // Opponent's resource pool is no longer tied to our caps. Their honey may
    // still drift via passive regen, but it never *drops*.
    expect(after.opponent.honey).toBeGreaterThanOrEqual(oppHoneyBefore);
  });
});

describe('engine: chain bonus on shared tile', () => {
  test('two paths sharing a tile pay the chain-multiplied honey bonus', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Two L-shaped words sharing the corner at (0,-2).
    const w1 = [hex(-2, 0), hex(-1, -1), hex(0, -2)] as const;
    const w2 = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        // Low starting honey so the +15 chain bonus has headroom under the cap.
        honey: 8,
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
    expect(submit.world.self.honey).toBe(8);
    const after = advance(submit.world, 4.0, rng);
    // CAT (5) + TAB (5) = 10 baseline; chain ×1.5 → 15. Floor allowing for
    // some passive regen before the bonus lands and any chain-bonus log
    // entry.
    expect(after.self.honey).toBeGreaterThanOrEqual(15);
    expect(after.self.tiles.filter((t) => t.state === 'capped').length).toBeGreaterThanOrEqual(5);
    expect(
      after.log.some(
        (e) => e.text.includes('CAT') && e.text.includes('TAB') && e.text.includes('chain'),
      ),
    ).toBe(true);
  });

  test('two non-overlapping words pay only the sum (no chain bonus)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const w1 = [hex(-2, 0), hex(-1, -1)] as const;
    const w2 = [hex(2, -2), hex(1, -1)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 8,
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
    // AT (2) + BE (4) = 6 baseline, no chain bonus, no chain tag in log.
    expect(after.self.honey).toBeGreaterThanOrEqual(14); // 8 (no drone cost) + 6
    expect(after.log.every((e) => !e.text.includes('chain'))).toBe(true);
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

describe('engine: word submission replay rules', () => {
  test('accepts more paths than drone capacity in one submit', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const p1 = [hex(0, -2), hex(1, -2)] as const;
    const p2 = [hex(1, -2), hex(2, -2)] as const;
    const p3 = [hex(-2, 0), hex(-1, -1)] as const;
    const p4 = [hex(-2, 2), hex(-1, 1)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 50,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, p1[0])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, p1[1])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, p2[1])) return { ...t, state: 'letter', letter: 'E' };
          if (hexEquals(t.hex, p3[0])) return { ...t, state: 'letter', letter: 'B' };
          if (hexEquals(t.hex, p3[1])) return { ...t, state: 'letter', letter: 'E' };
          if (hexEquals(t.hex, p4[0])) return { ...t, state: 'letter', letter: 'N' };
          if (hexEquals(t.hex, p4[1])) return { ...t, state: 'letter', letter: 'O' };
          return t;
        }),
      },
    };
    const submit = trySubmitWord(w, 'self', [p1, p2, p3, p4]);
    expect(submit.ok).toBe(true);
  });

  test('rejects replaying the exact same word on the same hex letters', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 30,
        tiles: w.self.tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      },
    };
    const first = trySubmitWord(w, 'self', [path]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = trySubmitWord(first.world, 'self', [path]);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toMatch(/already used/i);
    }
  });
});

describe('engine: dispatchCarpenter + frontier expansion', () => {
  test('accepts a frontier hex adjacent to active, rejects others', () => {
    const w0 = buildInitialWorld(fixedRng());
    // (3,-3) sits on the immediate frontier outside the ring-2 active tiles.
    const r1 = dispatchCarpenter(w0, 'self', hex(3, -3));
    expect(r1.ok).toBe(true);

    // A storage hex (ring 1) is owned but not eligible.
    const storage = w0.self.tiles.find((t) => t.state === 'storage')!.hex;
    const bad = dispatchCarpenter(w0, 'self', storage);
    expect(bad.ok).toBe(false);

    // A hex far away (not touching the hive) is also not eligible.
    const farAway = hex(10, -10);
    const bad2 = dispatchCarpenter(w0, 'self', farAway);
    expect(bad2.ok).toBe(false);
  });

  test('refuses when the player cannot afford a carpenter', () => {
    const w0 = buildInitialWorld(fixedRng());
    const w = { ...w0, self: { ...w0.self, honey: 0 } };
    const r = dispatchCarpenter(w, 'self', hex(3, -3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/honey/);
  });

  test('carpenter bee activates the targeted frontier hex (appending a new tile)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, self: { ...w.self, honey: 20 } };
    const target = hex(3, -3);
    const tilesBefore = w.self.tiles.length;
    const s = dispatchCarpenter(w, 'self', target);
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
    const sp1 = dispatchCarpenter(w, 'self', hex(3, -3));
    if (!sp1.ok) throw new Error('step1 spawn failed');
    w = advance(sp1.world, 4.0, rng);
    expect(w.self.tiles.find((t) => hexEquals(t.hex, hex(3, -3)))?.state).toBe('active');

    // Second step: (4,-3) is now on the frontier of (3,-3). Activate it.
    expect(frontierFor(w.self).some((h) => hexEquals(h, hex(4, -3)))).toBe(true);
    const sp2 = dispatchCarpenter(w, 'self', hex(4, -3));
    if (!sp2.ok) throw new Error('step2 spawn failed');
    w = advance(sp2.world, 4.0, rng);
    expect(w.self.tiles.find((t) => hexEquals(t.hex, hex(4, -3)))?.state).toBe('active');
  });
});

describe('engine: applyCommand routes every gameplay verb', () => {
  test('dispatchWorker via applyCommand spawns the same bee as the direct call', () => {
    const rng = fixedRng();
    const w0 = buildInitialWorld(rng);
    const petal = firstPetal(w0);
    const direct = dispatchWorker(w0, 'self', petal.hex);
    const routed = applyCommand(w0, 'self', { kind: 'dispatchWorker', target: petal.hex });
    expect(direct.ok).toBe(true);
    expect(routed.ok).toBe(true);
    if (!direct.ok || !routed.ok) return;
    expect(routed.world.self.bees).toHaveLength(direct.world.self.bees.length);
    expect(routed.world.self.honey).toBeCloseTo(direct.world.self.honey);
  });

  test('placeLetter and submitWords reach the engine in one call each', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Pre-fill a storage slot so placeLetter has something to move.
    const storage = w.self.tiles.find((t) => t.state === 'storage')!;
    const active = w.self.tiles.find((t) => t.state === 'active')!;
    w = {
      ...w,
      self: {
        ...w.self,
        honey: 30,
        tiles: w.self.tiles.map((t) =>
          hexEquals(t.hex, storage.hex) ? { ...t, letter: 'A' as const } : t,
        ),
      },
    };
    const placed = applyCommand(w, 'self', {
      kind: 'placeLetter',
      from: storage.hex,
      to: active.hex,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    // Now lay out a tiny CAT word in the same world and submit it.
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    let w2 = placed.world;
    w2 = {
      ...w2,
      self: {
        ...w2.self,
        tiles: w2.self.tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      },
    };
    const submit = applyCommand(w2, 'self', { kind: 'submitWords', paths: [path] });
    expect(submit.ok).toBe(true);
  });
});

describe('engine: worldToSnapshot perspective swap', () => {
  test('viewer="self" mirrors the world directly; viewer="opponent" swaps sides and remaps winner', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, self: { ...w.self, honey: 17 }, opponent: { ...w.opponent, honey: 4 } };

    const a = worldToSnapshot(w, 'self', 7);
    expect(a.tick).toBe(7);
    expect(a.self.honey).toBe(17);
    expect(a.opponent.honey).toBe(4);
    expect(a.winner).toBeNull();

    const b = worldToSnapshot(w, 'opponent', 7);
    expect(b.self.honey).toBe(4);
    expect(b.opponent.honey).toBe(17);
    expect(b.winner).toBeNull();

    // After a victory: viewer who matches winner sees `'self'`, the other sees `'opponent'`.
    const won: World = { ...w, phase: 'over', winner: 'self' };
    expect(worldToSnapshot(won, 'self', 0).winner).toBe('self');
    expect(worldToSnapshot(won, 'opponent', 0).winner).toBe('opponent');
  });

  test('opponent-perspective snapshot flips bee panels: a self-side worker reads as opponent-hive for the joiner', () => {
    // Spawn a bee on the engine's `self` side. On the wire this player is
    // the host; the joiner (viewerSide='opponent') should see this bee
    // emanating from their *opponent* hive, not their own.
    let w = buildInitialWorld(fixedRng());
    const petal = firstPetal(w);
    const dispatched = dispatchWorker(w, 'self', petal.hex);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    w = dispatched.world;

    const hostSnap = worldToSnapshot(w, 'self', 0);
    const joinerSnap = worldToSnapshot(w, 'opponent', 0);

    const hostBee = hostSnap.self.bees[0]!;
    expect(hostBee.state.kind).toBe('worker-flying-to-flower');
    if (hostBee.state.kind === 'worker-flying-to-flower') {
      expect(hostBee.state.flight.from.panel).toBe('self-hive');
    }

    // From the joiner's perspective the same bee is the *opponent's*: it
    // lives in `opponent.bees` and its origin panel must be flipped.
    const joinerBee = joinerSnap.opponent.bees[0]!;
    expect(joinerBee.state.kind).toBe('worker-flying-to-flower');
    if (joinerBee.state.kind === 'worker-flying-to-flower') {
      expect(joinerBee.state.flight.from.panel).toBe('opponent-hive');
      // The flowers panel is shared and must NOT be flipped.
      expect(joinerBee.state.flight.to.panel).toBe('flowers');
    }
  });
});
