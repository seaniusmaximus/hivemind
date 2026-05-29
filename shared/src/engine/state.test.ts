import { axialToPixel, distance, hex, hexEquals, hexKey, neighbors } from '../hex.js';
import { BEE_STATS, HEXES_PER_QUEEN_SLOT, HIVE, QUEEN_MIN_OWNED_HEXES } from '../bees.js';
import { makeRng } from '../letters.js';
import type { Petal } from '../messages.js';
import {
  activeQueenCountFor,
  applyCommand,
  buildInitialWorld,
  dispatchCarpenter,
  dispatchQueen,
  dispatchWorker,
  frontierFor,
  honeyCapFor,
  honeyRateFor,
  petalAt,
  pickQueenLandingHexForSide,
  pickQueenLandingHexWhileFlying,
  queenApproachVoidHexKeys,
  placeLetter,
  queenAllowanceFor,
  queenPerimeterLandingHexKeys,
  trySubmitWord,
  tickWorld,
  worldToSnapshot,
  patchTargetForPlayers,
  pollenBloomPatchCountForPlayers,
  eliminateByForfeit,
  PATCH_LIFETIME_SECONDS,
  PATCH_TARGET_COUNT,
  POLLEN_BLOOM_PATCH_COUNT,
  secondPlayer,
  getPlayer,
  setPlayerById,
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

/** Pad self with real frontier tiles until the queen size gate is satisfied. */
const expandSelfToMinQueenTiles = (w: World): World => {
  let next = w;
  while (getPlayer(next, "self").tiles.length < QUEEN_MIN_OWNED_HEXES) {
    const f = frontierFor(getPlayer(next, "self"));
    const h = f[0];
    if (!h) throw new Error('expandSelfToMinQueenTiles: empty frontier');
    next = setPlayerById(next, "self", {
        ...getPlayer(next, "self"),
        tiles: [
          ...getPlayer(next, "self").tiles,
          { hex: h, state: 'active' as const, letter: null, reuseCount: 0, damage: 0 },
        ],
      });
  }
  return next;
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
    const center = getPlayer(w, "self").tiles.find((t) => t.hex.q === 0 && t.hex.r === 0);
    expect(center?.state).toBe('hive');
    expect(getPlayer(w, "self").tiles.filter((t) => t.state === 'storage')).toHaveLength(6);
    expect(getPlayer(w, "self").tiles.filter((t) => t.state === 'active')).toHaveLength(12);
    expect(getPlayer(w, "self").tiles.filter((t) => t.state === 'inactive')).toHaveLength(0);
    expect(getPlayer(w, "self").tiles.every((t) => t.state !== 'storage' || t.letter === null)).toBe(true);
    expect(w.patches.length).toBe(PATCH_TARGET_COUNT);
    expect(getPlayer(w, "self").bees).toEqual([]);
    // Frontier is the immediate ring outside the active radius — 18 hexes.
    expect(frontierFor(getPlayer(w, "self"))).toHaveLength(18);
  });
});

describe('engine: honey economy', () => {
  test('regen rate scales linearly with owned hex count (no capped letters)', () => {
    const w = buildInitialWorld(fixedRng());
    const expected = HIVE.regenPerHex * getPlayer(w, "self").tiles.length;
    expect(honeyRateFor(getPlayer(w, "self"))).toBeCloseTo(expected);
    expect(honeyRateFor(secondPlayer(w))).toBeCloseTo(expected);
  });

  test('each capped letter adds HIVE.cappedHoneyBonus to the regen rate', () => {
    const w0 = buildInitialWorld(fixedRng());
    const baseRate = honeyRateFor(getPlayer(w0, "self"));
    const actives = getPlayer(w0, "self").tiles.filter((t) => t.state === 'active').slice(0, 3);
    const w1: World = setPlayerById(w0, 'self', {
        ...getPlayer(w0, "self"),
        tiles: getPlayer(w0, "self").tiles.map((t) =>
          actives.some((a) => hexEquals(a.hex, t.hex))
            ? { ...t, state: 'capped' as const, letter: 'A' as const }
            : t,
        ),
      });
    expect(honeyRateFor(getPlayer(w1, "self"))).toBeCloseTo(baseRate + 3 * HIVE.cappedHoneyBonus);
  });

  test('cap formula = hiveStorage + count(non-storage non-hive tiles)', () => {
    const w = buildInitialWorld(fixedRng());
    const honeycomb = getPlayer(w, "self").tiles.filter(
      (t) => t.state !== 'storage' && t.state !== 'hive',
    ).length;
    expect(honeycomb).toBe(12);
    expect(honeyCapFor(getPlayer(w, "self"))).toBe(HIVE.hiveStorage + honeycomb);
  });

  test('placing a letter (active → letter) does not change the cap', () => {
    const w0 = buildInitialWorld(fixedRng());
    const before = honeyCapFor(getPlayer(w0, "self"));
    const target = getPlayer(w0, "self").tiles.find((t) => t.state === 'active')!;
    const w1: World = setPlayerById(w0, 'self', {
        ...getPlayer(w0, "self"),
        tiles: getPlayer(w0, "self").tiles.map((t) =>
          hexEquals(t.hex, target.hex) ? { ...t, state: 'letter', letter: 'A' } : t,
        ),
      });
    expect(honeyCapFor(getPlayer(w1, "self"))).toBe(before);
  });

  test('passive regen accrues over time, clamped at the per-player cap', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Burn the starting honey down so regen has room.
    w = setPlayerById(setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 0 }), "opponent", { ...secondPlayer(w), honey: 0 });
    const after = advance(w, 4.0, rng);
    // Linear projection bounded by the cap — works for any `regenPerHex`
    // setting (designers retune it freely).
    const projected = honeyRateFor(getPlayer(w, "self")) * 4.0;
    const expected = Math.min(projected, honeyCapFor(getPlayer(w, "self")));
    expect(getPlayer(after, "self").honey).toBeGreaterThan(expected - 0.5);
    expect(getPlayer(after, "self").honey).toBeLessThanOrEqual(honeyCapFor(getPlayer(after, "self")) + 1e-6);
  });

  test('honey at cap will not exceed the cap on further ticks', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const cap = honeyCapFor(getPlayer(w, "self"));
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: cap });
    const after = advance(w, 2.0, rng);
    expect(getPlayer(after, "self").honey).toBeLessThanOrEqual(honeyCapFor(getPlayer(after, "self")) + 1e-6);
  });
});

describe('engine: queen allowance scales with hive size', () => {
  test('allowance is 1 + floor(tiles.length / HEXES_PER_QUEEN_SLOT)', () => {
    const w = buildInitialWorld(fixedRng());
    expect(queenAllowanceFor(getPlayer(w, "self"))).toBe(
      1 + Math.floor(getPlayer(w, "self").tiles.length / HEXES_PER_QUEEN_SLOT),
    );
    // Stub a player at a specific tile count (formula depends only on length).
    const sample = getPlayer(w, "self").tiles[0]!;
    const tilesOfSize = (n: number) =>
      Array.from({ length: n }, () => sample);
    const playerWith = (n: number) => ({ ...getPlayer(w, "self"), tiles: tilesOfSize(n) });
    expect(queenAllowanceFor(playerWith(0))).toBe(1);
    expect(queenAllowanceFor(playerWith(11))).toBe(1);
    expect(queenAllowanceFor(playerWith(12))).toBe(2);
    expect(queenAllowanceFor(playerWith(23))).toBe(2);
    expect(queenAllowanceFor(playerWith(24))).toBe(3);
    expect(queenAllowanceFor(playerWith(36))).toBe(4);
  });

  test('dispatchQueen succeeds repeatedly until the allowance is reached', () => {
    const rng = fixedRng();
    let w = expandSelfToMinQueenTiles(buildInitialWorld(rng));
    // Big stockpile + tile pool that generates a 3-queen allowance.
    const allowance = queenAllowanceFor(getPlayer(w, "self"));
    expect(allowance).toBeGreaterThanOrEqual(2);
    w = setPlayerById(w, 'self', {
      ...getPlayer(w, 'self'),
      honey: BEE_STATS.queen.honeyCost * (allowance + 2),
    });
    let cumulative = w;
    for (let i = 0; i < allowance; i++) {
      const r = dispatchQueen(cumulative, 'self');
      expect(r.ok).toBe(true);
      cumulative = r.world;
    }
    expect(activeQueenCountFor(getPlayer(cumulative, 'self'))).toBe(allowance);
    const blocked = dispatchQueen(cumulative, 'self');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('queen allowance reached');
  });

  test('honey shortage rejects before the allowance check', () => {
    const w = buildInitialWorld(fixedRng());
    const broke: World = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 0 });
    const r = dispatchQueen(broke, 'self');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not enough honey');
  });

  test('dispatchQueen rejects when hive is below QUEEN_MIN_OWNED_HEXES', () => {
    const w = buildInitialWorld(fixedRng());
    expect(getPlayer(w, "self").tiles.length).toBeLessThan(QUEEN_MIN_OWNED_HEXES);
    const rich: World = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 500 });
    const r = dispatchQueen(rich, 'self');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('queen min hive size');
  });

  test('caller-supplied target lands the queen on that hex', () => {
    const rng = fixedRng();
    const base = buildInitialWorld(rng);
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const enemyActive = secondPlayer(w).tiles.find((t) => t.state === 'active')!;
    const r = dispatchQueen(w, 'self', { target: enemyActive.hex });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const queen = getPlayer(r.world, "self").bees[getPlayer(r.world, "self").bees.length - 1]!;
    expect(queen.kind).toBe('queen');
    if (queen.state.kind !== 'queen-flying') {
      throw new Error('expected queen-flying state');
    }
    expect(hexEquals(queen.state.landingHex, enemyActive.hex)).toBe(true);
  });

  test('in-flight queen keeps chosen landing hex across engine ticks', () => {
    const rng = fixedRng();
    const base = buildInitialWorld(rng);
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const ring = queenPerimeterLandingHexKeys(secondPlayer(w));
    const outer = secondPlayer(w).tiles.find((t) => ring.has(hexKey(t.hex)))!;
    const r0 = dispatchQueen(w, 'self', { target: outer.hex });
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    let cur = r0.world;
    const q0 = getPlayer(cur, "self").bees[getPlayer(cur, "self").bees.length - 1]!;
    if (q0.state.kind !== 'queen-flying') throw new Error('expected queen-flying');
    for (let i = 0; i < 20; i++) {
      cur = tickWorld(cur, 1 / 30, rng);
    }
    const q1 = getPlayer(cur, "self").bees.find((b) => b.id === q0.id);
    expect(q1?.state.kind).toBe('queen-flying');
    if (q1?.state.kind !== 'queen-flying') return;
    expect(hexEquals(q1.state.landingHex, outer.hex)).toBe(true);
  });

  test('in-flight queen retargets when its landing tile is destroyed', () => {
    const rng = fixedRng();
    const base = buildInitialWorld(rng);
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const ring = queenPerimeterLandingHexKeys(secondPlayer(w));
    const outer = secondPlayer(w).tiles.find((t) => ring.has(hexKey(t.hex)))!;
    const r0 = dispatchQueen(w, 'self', { target: outer.hex });
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    const q0 = getPlayer(r0.world, "self").bees[getPlayer(r0.world, "self").bees.length - 1]!;
    let cur: World = setPlayerById(r0.world, 'opponent', {
        ...secondPlayer(r0.world),
        tiles: secondPlayer(r0.world).tiles.filter((t) => !hexEquals(t.hex, outer.hex)),
      });
    cur = tickWorld(cur, 1 / 30, rng);
    const q1 = getPlayer(cur, "self").bees.find((b) => b.id === q0.id);
    expect(q1?.state.kind).toBe('queen-flying');
    if (q1?.state.kind !== 'queen-flying') return;
    expect(hexEquals(q1.state.landingHex, outer.hex)).toBe(false);
    expect(queenPerimeterLandingHexKeys(secondPlayer(cur)).has(hexKey(q1.state.landingHex))).toBe(true);
  });

  test('in-flight queen retargets inward when a rebuilt tile blocks the ingress path', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    const origin = hex(0, 0);
    const ring = queenPerimeterLandingHexKeys(secondPlayer(w));
    const outer = secondPlayer(w).tiles.find((t) => ring.has(hexKey(t.hex)))!;
    const inner = neighbors(outer.hex).find((n) => {
      const t = secondPlayer(w).tiles.find((tile) => hexEquals(tile.hex, n));
      return (
        t &&
        t.state !== 'hive' &&
        t.state !== 'inactive' &&
        distance(n, origin) < distance(outer.hex, origin)
      );
    });
    expect(inner).toBeDefined();
    if (!inner) return;
    const innerTile = secondPlayer(w).tiles.find((t) => hexEquals(t.hex, inner))!;
    const withoutInner: World = setPlayerById(w, 'opponent', {
        ...secondPlayer(w),
        tiles: secondPlayer(w).tiles.filter((t) => !hexEquals(t.hex, inner)),
      });
    const withInner: World = setPlayerById(withoutInner, 'opponent', {
        ...secondPlayer(withoutInner),
        tiles: [
          ...secondPlayer(withoutInner).tiles,
          { ...innerTile, state: 'active', letter: null, damage: 0, reuseCount: 0 },
        ],
      });
    const approachKeys = queenApproachVoidHexKeys(secondPlayer(withoutInner), outer.hex);
    const desired = pickQueenLandingHexWhileFlying(
      secondPlayer(withInner),
      outer.hex,
      undefined,
      approachKeys,
    );
    expect(desired).not.toBeNull();
    expect(hexEquals(desired!, inner)).toBe(true);
  });

  test('queen spawn rejects inner ring (non-perimeter) targets', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const inner = secondPlayer(w).tiles.find((t) => t.state === 'storage')!;
    expect(queenPerimeterLandingHexKeys(secondPlayer(w)).has(hexKey(inner.hex))).toBe(false);
    const r = dispatchQueen(w, 'self', { target: inner.hex });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid queen target');
  });

  test('target on the enemy central hive is rejected', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const enemyHive = secondPlayer(w).tiles.find((t) => t.state === 'hive')!;
    const r = dispatchQueen(w, 'self', { target: enemyHive.hex });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid queen target');
  });

  test('target that the enemy does not own is rejected', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const r = dispatchQueen(w, 'self', { target: { q: 99, r: -99 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid queen target');
  });

  test('pickQueenLandingHexForSide returns a perimeter hex aligned with that side', () => {
    const w = buildInitialWorld(fixedRng());
    const ring = queenPerimeterLandingHexKeys(secondPlayer(w));
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const h = pickQueenLandingHexForSide(secondPlayer(w), side);
      expect(h).not.toBeNull();
      expect(ring.has(hexKey(h!))).toBe(true);
      const { x, y } = axialToPixel(h!, 30);
      if (side === 'top') expect(y).toBeLessThan(0);
      if (side === 'bottom') expect(y).toBeGreaterThan(0);
      if (side === 'left') expect(x).toBeLessThan(0);
      if (side === 'right') expect(x).toBeGreaterThan(0);
    }
  });

  test('dispatchQueen with attackSide lands on pickQueenLandingHexForSide hex', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const expected = pickQueenLandingHexForSide(secondPlayer(w), 'left');
    const r = dispatchQueen(w, 'self', { attackSide: 'left' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const queen = getPlayer(r.world, "self").bees[getPlayer(r.world, "self").bees.length - 1]!;
    if (queen.state.kind !== 'queen-flying') throw new Error('expected queen-flying');
    expect(hexEquals(queen.state.landingHex, expected!)).toBe(true);
  });

  test('dispatchQueen rejects both target and attackSide', () => {
    const base = buildInitialWorld(fixedRng());
    let w = expandSelfToMinQueenTiles(base);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: BEE_STATS.queen.honeyCost + 1 });
    const outer = secondPlayer(w).tiles.find((t) =>
      queenPerimeterLandingHexKeys(secondPlayer(w)).has(hexKey(t.hex)),
    )!;
    const r = dispatchQueen(w, 'self', { target: outer.hex, attackSide: 'top' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('queen attack overspecified');
  });
});

describe('engine: queen hive breach', () => {
  test('queen occupying the hive center ends the game', () => {
    const w0 = buildInitialWorld(fixedRng());
    const queenBee = {
      id: 'queen-test',
      kind: 'queen' as const,
      ownerId: getPlayer(w0, "self").id,
      capacity: 1,
      state: {
        kind: 'queen-assault' as const,
        panel: 'opponent-hive' as const,
        defenderPlayerId: 'opponent',
        currentHex: hex(0, 0),
        expiresAt: 100,
        nextActionAt: 0,
      },
    };
    const w: World = setPlayerById({ ...w0, t: 1 }, 'self', { ...getPlayer(w0, "self"), bees: [queenBee] });
    const after = tickWorld(w, 0, fixedRng());
    expect(after.phase).toBe('over');
    expect(after.winnerId).toBe('self');
  });

  test('queen destroying a storage hex ends the game', () => {
    const w0 = buildInitialWorld(fixedRng());
    const storage = secondPlayer(w0).tiles.find((t) => t.state === 'storage')!;
    const queenBee = {
      id: 'queen-test',
      kind: 'queen' as const,
      ownerId: getPlayer(w0, "self").id,
      capacity: 1,
      state: {
        kind: 'queen-assault' as const,
        panel: 'opponent-hive' as const,
        defenderPlayerId: 'opponent',
        currentHex: storage.hex,
        expiresAt: 100,
        nextActionAt: 0,
      },
    };
    const w: World = setPlayerById(
      { ...w0, t: 1 },
      'self',
      { ...getPlayer(w0, "self"), bees: [queenBee] },
    );
    const w2 = setPlayerById(w, 'opponent', {
        ...secondPlayer(w0),
        tiles: secondPlayer(w0).tiles.map((t) =>
          hexEquals(t.hex, storage.hex) ? { ...t, damage: 0.75 } : t,
        ),
      });
    const after = tickWorld(w2, 0, fixedRng());
    expect(after.phase).toBe('over');
    expect(after.winnerId).toBe('self');
    expect(secondPlayer(after).tiles.some((t) => t.state === 'storage' && hexEquals(t.hex, storage.hex))).toBe(
      false,
    );
  });
});

describe('engine: worker dispatch', () => {
  test('prefers a freed letter over a flower petal at the same hex', () => {
    const w0 = buildInitialWorld(fixedRng());
    const h = hex(0, -2);
    const patch = w0.patches[0]!;
    const w: World = {
      ...setPlayerById(w0, 'self', {
        ...getPlayer(w0, "self"),
        honey: 20,
        freedLetters: [
          {
            id: 'freed-1',
            hex: h,
            letter: 'M',
            spawnedAt: 0,
            witherAt: 100,
          },
        ],
      }),
      patches: [
        {
          ...patch,
          petals: [{ hex: h, letter: 'Z', witherAt: 100 } satisfies Petal],
        },
        ...w0.patches.slice(1),
      ],
    };
    expect(petalAt(w.patches, h)).not.toBeNull();
    const r = dispatchWorker(w, 'self', h);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const worker = getPlayer(r.world, "self").bees[getPlayer(r.world, "self").bees.length - 1]!;
    expect(worker.state.kind).toBe('worker-flying-to-freed');
  });
});

describe('engine: no time-based victory', () => {
  test('long simulations leave phase === "playing" when nobody breaches', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = setPlayerById(
      { ...w, t: 10 * 60 },
      'self',
      { ...getPlayer(w, "self"), honey: 50 },
    );
    w = setPlayerById(w, 'opponent', { ...secondPlayer(w), honey: 5 });
    const after = tickWorld(w, 0.05, rng);
    expect(after.phase).toBe('playing');
    expect(after.winnerId).toBeNull();
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
        // Even mid-cooldown, no two core patches of the same type should exist.
        const core = w.patches.filter((p) => !p.pollenBloom);
        const types = core.map((p) => p.type);
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
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        tiles: getPlayer(w, "self").tiles.map((tile) =>
          tile.state === 'storage' ? { ...tile, letter: 'A' as const } : tile,
        ),
      });
    const petal = firstPetal(w);
    const r = dispatchWorker(w, 'self', petal.hex);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/storage/);
  });

  test('rejects when the player cannot afford a worker', () => {
    const w0 = buildInitialWorld(fixedRng());
    const w = setPlayerById(w0, "self", { ...getPlayer(w0, "self"), honey: 0 });
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
    expect(getPlayer(r.world, "self").honey).toBeLessThan(getPlayer(w, "self").honey);
    const bee = getPlayer(r.world, "self").bees[0]!;
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
    const filledStorage = getPlayer(after, "self").tiles.filter(
      (tile) => tile.state === 'storage' && tile.letter !== null,
    );
    expect(filledStorage).toHaveLength(1);
    expect(filledStorage[0]!.letter).toBe(targetLetter);
    expect(getPlayer(after, "self").tiles.filter((t) => t.state === 'letter')).toHaveLength(0);
    expect(getPlayer(after, "self").bees).toHaveLength(0);
  });
});

describe('engine: race for the same petal', () => {
  test('first bee to arrive collects, second one misses', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const petal = firstPetal(w);

    w = setPlayerById(
      setPlayerById(w, 'self', { ...getPlayer(w, 'self'), honey: 20 }),
      'opponent',
      { ...secondPlayer(w), honey: 20 },
    );

    const s1 = dispatchWorker(w, 'self', petal.hex);
    if (!s1.ok) throw new Error('self spawn failed');
    w = s1.world;
    const s2 = dispatchWorker(w, 'opponent', petal.hex);
    if (!s2.ok) throw new Error('opp spawn failed');
    w = s2.world;

    const after = advance(w, 4.0, rng);
    const selfStored = getPlayer(after, "self").tiles.some(
      (t) => t.state === 'storage' && t.letter === petal.letter,
    );
    const oppStored = secondPlayer(after).tiles.some(
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
    const storage = getPlayer(w, "self").tiles.find((t) => t.state === 'storage')!;
    const active = getPlayer(w, "self").tiles.find((t) => t.state === 'active')!;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        tiles: getPlayer(w, "self").tiles.map((t) =>
          hexEquals(t.hex, storage.hex) ? { ...t, letter: 'C' as const } : t,
        ),
      });
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const movedSource = getPlayer(r.world, "self").tiles.find((t) => hexEquals(t.hex, storage.hex))!;
    const movedDest = getPlayer(r.world, "self").tiles.find((t) => hexEquals(t.hex, active.hex))!;
    expect(movedSource.state).toBe('storage');
    expect(movedSource.letter).toBe(null);
    expect(movedDest.state).toBe('active');
    expect(movedDest.letter).toBe('C');
  });

  test('can move an uncapped comb letter back into empty storage', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const storage = getPlayer(w, "self").tiles.find((t) => t.state === 'storage' && !t.letter)!;
    const active = getPlayer(w, "self").tiles.find((t) => t.state === 'active')!;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, active.hex)) return { ...t, state: 'active' as const, letter: 'Z' as const };
          return t;
        }),
      });
    const r = placeLetter(w, 'self', active.hex, storage.hex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = getPlayer(r.world, "self").tiles.find((t) => hexEquals(t.hex, active.hex))!;
    const dest = getPlayer(r.world, "self").tiles.find((t) => hexEquals(t.hex, storage.hex))!;
    expect(src.letter).toBe(null);
    expect(dest.letter).toBe('Z');
  });

  test('refuses if storage is empty', () => {
    const w = buildInitialWorld(fixedRng());
    const storage = getPlayer(w, "self").tiles.find((t) => t.state === 'storage')!;
    const active = getPlayer(w, "self").tiles.find((t) => t.state === 'active')!;
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(false);
  });

  test('refuses if destination is occupied', () => {
    let w = buildInitialWorld(fixedRng());
    const storage = getPlayer(w, "self").tiles.find((t) => t.state === 'storage')!;
    const active = getPlayer(w, "self").tiles.find((t) => t.state === 'active')!;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, storage.hex)) return { ...t, letter: 'A' as const };
          if (hexEquals(t.hex, active.hex)) return { ...t, state: 'active' as const, letter: 'B' as const };
          return t;
        }),
      });
    const r = placeLetter(w, 'self', storage.hex, active.hex);
    expect(r.ok).toBe(false);
  });
});

describe('engine: drone caps a placed word', () => {
  test('contiguous letter path → honey awarded, tiles capped, opponent untouched', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        // Low starting honey so the +5 bonus isn't clipped by the cap.
        honey: 8,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
    const oppHoneyBefore = secondPlayer(w).honey;
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    // Drone caps are free; honey is unchanged at submit time.
    expect(getPlayer(submit.world, "self").honey).toBe(8);
    const after = advance(submit.world, 3.0, rng);
    // CAT scores 5; bonus + a sliver of regen should leave us above the
    // pre-submit baseline.
    expect(getPlayer(after, "self").honey).toBeGreaterThan(12);
    expect(getPlayer(after, "self").tiles.filter((t) => t.state === 'capped')).toHaveLength(3);
    // Opponent's resource pool is no longer tied to our caps. Their honey may
    // still drift via passive regen, but it never *drops*.
    expect(secondPlayer(after).honey).toBeGreaterThanOrEqual(oppHoneyBefore);
  });

  test('bee-related word expands every adjacent frontier hex (bee bloom)', () => {
    const rng = fixedRng();
    const path = [hex(0, -2), hex(1, -2), hex(2, -2), hex(2, -1), hex(1, -1)] as const;
    const letters = ['Q', 'U', 'E', 'E', 'N'] as const;
    let w = buildInitialWorld(rng);
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          const i = path.findIndex((h) => hexEquals(t.hex, h));
          if (i >= 0) return { ...t, state: 'letter' as const, letter: letters[i]! };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const patchCountBefore = w.patches.length;
    const mid = advance(submit.world, 1.5, rng);
    expect(mid.log.some((e) => e.text.includes('pollen bloom'))).toBe(true);
    expect(mid.patches.length).toBe(patchCountBefore + POLLEN_BLOOM_PATCH_COUNT);
    expect(mid.patches.filter((p) => p.pollenBloom)).toHaveLength(POLLEN_BLOOM_PATCH_COUNT);
    expect(
      mid.patches
        .filter((p) => p.pollenBloom)
        .map((p) => p.type)
        .sort(),
    ).toEqual(['common', 'rare', 'vowel']);
    const carpenter = getPlayer(mid, "self").bees.find((b) => b.kind === 'carpenter');
    expect(carpenter).toBeDefined();
    if (carpenter?.state.kind !== 'carpenter-flying') return;
    // QUEEN length 5 → normal budget would be 3; bee bloom takes all neighbors.
    expect(carpenter.capacity).toBeGreaterThan(3);
    const owned = new Set(getPlayer(mid, "self").tiles.map((t) => hexKey(t.hex)));
    const neighborTargets = new Map<string, Hex>();
    for (const h of path) {
      for (const n of neighbors(h)) {
        const nk = hexKey(n);
        if (owned.has(nk)) continue;
        neighborTargets.set(nk, n);
      }
    }
    let eligibleNeighbors = 0;
    for (const n of neighborTargets.values()) {
      const touchesHive = neighbors(n).some((nb) => {
        const tile = getPlayer(mid, "self").tiles.find((t) => hexEquals(t.hex, nb));
        return (
          tile &&
          (tile.state === 'active' ||
            tile.state === 'letter' ||
            tile.state === 'capped')
        );
      });
      if (touchesHive) eligibleNeighbors++;
    }
    expect(carpenter.capacity).toBe(eligibleNeighbors);
  });

  test('pollen bloom bonus patches wither and despawn without refilling the core field', () => {
    const rng = fixedRng();
    const path = [hex(0, -2), hex(1, -2), hex(2, -2), hex(2, -1), hex(1, -1)] as const;
    const letters = ['Q', 'U', 'E', 'E', 'N'] as const;
    let w = buildInitialWorld(rng);
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          const i = path.findIndex((h) => hexEquals(t.hex, h));
          if (i >= 0) return { ...t, state: 'letter' as const, letter: letters[i]! };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    let cur = advance(submit.world, 1.5, rng);
    expect(cur.patches.filter((p) => p.pollenBloom)).toHaveLength(POLLEN_BLOOM_PATCH_COUNT);
    cur = advance(cur, PATCH_LIFETIME_SECONDS + 5, rng);
    expect(cur.patches.filter((p) => p.pollenBloom)).toHaveLength(0);
    expect(cur.patches.length).toBe(PATCH_TARGET_COUNT);
  });

  test('capping schedules one free carpenter that chains frontier hexes (no honey cost)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 8,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    // Drone flight completes at t0 + 1.4s; cap resolves and schedules one carpenter.
    const mid = advance(submit.world, 1.5, rng);
    const carpenters = getPlayer(mid, "self").bees.filter((b) => b.kind === 'carpenter');
    expect(carpenters.length).toBe(1);
    expect(carpenters.every((b) => b.state.kind === 'carpenter-flying')).toBe(true);
    const chain = carpenters[0]!;
    if (chain.state.kind === 'carpenter-flying') {
      // CAT is length 3 → n − 2 = 1 free frontier tile.
      expect(chain.capacity).toBe(1);
      expect(chain.state.queue).toHaveLength(0);
    }
    // Word payout applied; auto carpenters must not apply the 5-honey hold fee.
    expect(getPlayer(mid, "self").honey).toBeGreaterThan(12);
    const after = advance(mid, 3.0, rng);
    expect(getPlayer(after, "self").tiles.length).toBeGreaterThan(getPlayer(submit.world, "self").tiles.length);
  });
});

describe('engine: branch reuse honey bonus', () => {
  test('rejects submitting more than one word per drone', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const w1 = [hex(-2, 0), hex(-1, -1), hex(0, -2)] as const;
    const w2 = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 8,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, w1[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, w1[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, w1[2])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, w2[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, w2[2])) return { ...t, state: 'letter', letter: 'B' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [w1, w2]);
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(submit.reason).toMatch(/one word per drone/i);
  });

  test('a word through a prior-capped letter pays 1.5× that word score', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const corner = hex(0, -2);
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 8,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, corner)) return { ...t, state: 'capped', letter: 'A' };
          if (hexEquals(t.hex, hex(1, -2))) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [[corner, hex(1, -2)]]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const after = advance(submit.world, 3.0, rng);
    // AT base 2 → ×1.5 = 3 honey, plus passive regen from 8.
    expect(getPlayer(after, "self").honey).toBeGreaterThanOrEqual(11);
    expect(after.log.some((e) => e.text.includes('AT') && e.text.includes('reuse'))).toBe(true);
  });

  test('reuse cap still schedules frontier expansion from the word path', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2), hex(2, -1)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'capped', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, path[3])) return { ...t, state: 'letter', letter: 'S' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [path]);
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const mid = advance(submit.world, 1.5, rng);
    const carpenter = getPlayer(mid, "self").bees.find((b) => b.kind === 'carpenter');
    expect(carpenter).toBeDefined();
    if (carpenter?.state.kind === 'carpenter-flying') {
      // CATS length 4 → n − 2 = 2 frontier tiles.
      expect(carpenter.capacity).toBe(2);
    }
  });
});

describe('engine: branches reuse capped tiles', () => {
  test('a path through a previously capped tile is accepted and re-caps shared tiles', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const corner = hex(0, -2);
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, corner)) return { ...t, state: 'capped', letter: 'A' };
          if (hexEquals(t.hex, hex(1, -2))) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [[corner, hex(1, -2)]]);
    expect(submit.ok).toBe(true);
  });
});

describe('engine: word submission replay rules', () => {
  test('rejects multiple paths in one submit', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const p1 = [hex(0, -2), hex(1, -2)] as const;
    const p2 = [hex(1, -2), hex(2, -2)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 50,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, p1[0])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, p1[1])) return { ...t, state: 'letter', letter: 'T' };
          if (hexEquals(t.hex, p2[1])) return { ...t, state: 'letter', letter: 'E' };
          return t;
        }),
      });
    const submit = trySubmitWord(w, 'self', [p1, p2]);
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(submit.reason).toMatch(/one word per drone/i);
  });

  test('rejects replaying the exact same word on the same hex letters', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    const path = [hex(0, -2), hex(1, -2), hex(2, -2)] as const;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
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
    const storage = getPlayer(w0, "self").tiles.find((t) => t.state === 'storage')!.hex;
    const bad = dispatchCarpenter(w0, 'self', storage);
    expect(bad.ok).toBe(false);

    // A hex far away (not touching the hive) is also not eligible.
    const farAway = hex(10, -10);
    const bad2 = dispatchCarpenter(w0, 'self', farAway);
    expect(bad2.ok).toBe(false);
  });

  test('refuses when the player cannot afford a carpenter', () => {
    const w0 = buildInitialWorld(fixedRng());
    const w = setPlayerById(w0, "self", { ...getPlayer(w0, "self"), honey: 0 });
    const r = dispatchCarpenter(w, 'self', hex(3, -3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/honey/);
  });

  test('carpenter bee activates the targeted frontier hex (appending a new tile)', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 20 });
    const target = hex(3, -3);
    const tilesBefore = getPlayer(w, "self").tiles.length;
    const s = dispatchCarpenter(w, 'self', target);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    w = s.world;
    const after = advance(w, 4.0, rng);
    const tile = getPlayer(after, "self").tiles.find((tt) => hexEquals(tt.hex, target));
    expect(tile?.state).toBe('active');
    expect(getPlayer(after, "self").tiles.length).toBe(tilesBefore + 1);
    expect(getPlayer(after, "self").bees).toHaveLength(0);
  });

  test('carpenters can expand the hive past the initial radius', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 100 });
    // First step: activate (3,-3) at radius 3.
    const sp1 = dispatchCarpenter(w, 'self', hex(3, -3));
    if (!sp1.ok) throw new Error('step1 spawn failed');
    w = advance(sp1.world, 4.0, rng);
    expect(getPlayer(w, "self").tiles.find((t) => hexEquals(t.hex, hex(3, -3)))?.state).toBe('active');

    // Second step: (4,-3) is now on the frontier of (3,-3). Activate it.
    expect(frontierFor(getPlayer(w, "self")).some((h) => hexEquals(h, hex(4, -3)))).toBe(true);
    const sp2 = dispatchCarpenter(w, 'self', hex(4, -3));
    if (!sp2.ok) throw new Error('step2 spawn failed');
    w = advance(sp2.world, 4.0, rng);
    expect(getPlayer(w, "self").tiles.find((t) => hexEquals(t.hex, hex(4, -3)))?.state).toBe('active');
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
    expect(getPlayer(routed.world, "self").bees).toHaveLength(getPlayer(direct.world, "self").bees.length);
    expect(getPlayer(routed.world, "self").honey).toBeCloseTo(getPlayer(direct.world, "self").honey);
  });

  test('placeLetter and submitWords reach the engine in one call each', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    // Pre-fill a storage slot so placeLetter has something to move.
    const storage = getPlayer(w, "self").tiles.find((t) => t.state === 'storage')!;
    const active = getPlayer(w, "self").tiles.find((t) => t.state === 'active')!;
    w = setPlayerById(w, "self", {
        ...getPlayer(w, "self"),
        honey: 30,
        tiles: getPlayer(w, "self").tiles.map((t) =>
          hexEquals(t.hex, storage.hex) ? { ...t, letter: 'A' as const } : t,
        ),
      });
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
    w2 = setPlayerById(w2, 'self', {
        ...getPlayer(w2, "self"),
        tiles: getPlayer(w2, "self").tiles.map((t) => {
          if (hexEquals(t.hex, path[0])) return { ...t, state: 'letter', letter: 'C' };
          if (hexEquals(t.hex, path[1])) return { ...t, state: 'letter', letter: 'A' };
          if (hexEquals(t.hex, path[2])) return { ...t, state: 'letter', letter: 'T' };
          return t;
        }),
      });
    const submit = applyCommand(w2, 'self', { kind: 'submitWords', paths: [path] });
    expect(submit.ok).toBe(true);
  });
});

describe('engine: worldToSnapshot perspective swap', () => {
  test('viewer="self" mirrors the world directly; viewer="opponent" swaps sides and remaps winner', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = setPlayerById(setPlayerById(w, "self", { ...getPlayer(w, "self"), honey: 17 }), "opponent", { ...secondPlayer(w), honey: 4 });

    const a = worldToSnapshot(w, 'self', 7);
    expect(a.tick).toBe(7);
    expect(a.self.honey).toBe(17);
    expect(a.opponents[0]!.honey).toBe(4);
    expect(a.winner).toBeNull();

    const b = worldToSnapshot(w, 'opponent', 7);
    expect(b.self.honey).toBe(4);
    expect(b.opponents[0]!.honey).toBe(17);
    expect(b.winner).toBeNull();

    // After a victory: viewer who matches winner sees `'self'`, the other sees `'opponent'`.
    const won: World = { ...w, phase: 'over', winnerId: 'self' };
    expect(worldToSnapshot(won, 'self', 0).winner).toBe('self');
    expect(worldToSnapshot(won, 'opponent', 0).winner).toBeNull();
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
    const joinerBee = joinerSnap.opponents[0].bees[0]!;
    expect(joinerBee.state.kind).toBe('worker-flying-to-flower');
    if (joinerBee.state.kind === 'worker-flying-to-flower') {
      expect(joinerBee.state.flight.from.panel).toBe('opponent-hive-right');
      // The flowers panel is shared and must NOT be flipped.
      expect(joinerBee.state.flight.to.panel).toBe('flowers');
    }
  });
});

describe('engine: N-player FFA', () => {
  test('flower patch counts scale with player count', () => {
    expect(patchTargetForPlayers(2)).toBe(PATCH_TARGET_COUNT);
    expect(patchTargetForPlayers(3)).toBe(PATCH_TARGET_COUNT + 1);
    expect(patchTargetForPlayers(4)).toBe(PATCH_TARGET_COUNT + 2);
    expect(pollenBloomPatchCountForPlayers(2)).toBe(POLLEN_BLOOM_PATCH_COUNT);
    expect(pollenBloomPatchCountForPlayers(4)).toBe(POLLEN_BLOOM_PATCH_COUNT + 2);
    const w4 = buildInitialWorld(fixedRng(), { playerIds: ['a', 'b', 'c', 'd'] });
    expect(w4.patches.length).toBe(patchTargetForPlayers(4));
    expect(w4.playerCount).toBe(4);
    expect(w4.activePlayerIds).toHaveLength(4);
  });

  test('forfeit elimination chain leaves one winner in FFA', () => {
    let w = buildInitialWorld(fixedRng(), { playerIds: ['p0', 'p1', 'p2'] });
    w = eliminateByForfeit(w, 'p2');
    expect(w.activePlayerIds).toEqual(['p0', 'p1']);
    expect(w.eliminatedPlayerIds).toContain('p2');
    expect(w.phase).toBe('playing');
    w = eliminateByForfeit(w, 'p1');
    expect(w.phase).toBe('over');
    expect(w.winnerId).toBe('p0');
    expect(w.activePlayerIds).toEqual(['p0']);
  });

  test('worldToSnapshot still includes eliminated rivals for navigation', () => {
    let w = buildInitialWorld(fixedRng(), { playerIds: ['p0', 'p1', 'p2', 'p3'] });
    w = eliminateByForfeit(w, 'p3');
    const snap = worldToSnapshot(w, 'p0', 1);
    expect(snap.opponents).toHaveLength(3);
    expect(snap.eliminatedPlayerIds).toContain('p3');
    expect(snap.opponents.map((o) => o.id)).toContain('p3');
  });

  test('worldToSnapshot assigns spatial opponent slots for four players', () => {
    const w = buildInitialWorld(fixedRng(), { playerIds: ['p0', 'p1', 'p2', 'p3'] });
    const snap = worldToSnapshot(w, 'p0', 1);
    expect(snap.opponents).toHaveLength(3);
    expect(snap.opponentSlots).toEqual(['right', 'above', 'below']);
    expect(snap.playerCount).toBe(4);
  });
});

