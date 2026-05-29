/**
 * Game-state engine — single source of truth for every player- and
 * server-driven mutation of the world.
 *
 * Hive layout: each player starts with a single `'hive'` tile at axial (0,0),
 * 6 `'storage'` slots at radius 1, and 12 `'active'` tiles at radius 2.
 * Carpenters expand the hive *outward indefinitely* — any hex adjacent to your
 * active/letter/capped tiles is a "frontier" hex that can be activated. A
 * hold-to-send spends honey; capping a word with a drone also schedules one
 * free carpenter that visits up to (word length − 2) adjacent unowned hexes.
 * Honey for a capped word is the sum of its letter point values (see scoring).
 * around the capped word path (including reused tiles), in sequence (same
 * animation as a manual hold, no honey). The renderer
 * derives the frontier on the fly via
 * {@link frontierFor}; the engine only stores tiles you actually own.
 *
 * Flower field: at any time exactly {@link PATCH_TARGET_COUNT} core flower
 * patches bloom in the central field (one vowel, one common, one rare). A
 * pollen bloom from a bee-related word adds {@link POLLEN_BLOOM_PATCH_COUNT}
 * bonus patches that decay normally but do not count toward that invariant.
 *
 * Workers and carpenters are dispatched directly via a hold-to-send gesture
 * on a target hex (the UI enforces the hold duration). Each hold spawns one
 * bee with a single paid job. Post-cap frontier expansion reuses the same bee
 * type with a multi-hex queue and raised capacity so tiles activate one after
 * another. If the target is gone when the
 * bee arrives (a withered petal, a collected petal, or a frontier hex that
 * is no longer adjacent to the hive) the bee logs a miss and returns home.
 *
 * The smart single-player AI lives in {@link tickSmartAi} (ai.ts); it is
 * *not* called by {@link tickWorld} so the server can drive an authoritative
 * tick without either side getting phantom AI commands. Solo callers compose
 * them via {@link tickSolo}.
 */

import {
  BEE_STATS,
  FLIGHT_TIMES,
  HEXES_PER_QUEEN_SLOT,
  HIVE,
  QUEEN_MIN_OWNED_HEXES,
  WORKER_HOLD_SECONDS,
  type Bee,
  type BeeFlight,
  type BeePanel,
  type BeeState,
  type BeeWaypoint,
} from '../bees.js';
import {
  FLOWER_LETTER_POOLS,
  drawFlowerLetter,
  type FlowerType,
  type Letter,
} from '../letters.js';
import {
  axialToPixel,
  hex,
  hexEquals,
  hexKey,
  isValidPath,
  neighbors,
  range,
  type Hex,
} from '../hex.js';
import { isBeeRelatedWord } from '../beeWords.js';
import { honeyForCappedWord, recordBestWord, wordScore } from '../scoring.js';
import { hexHpForTile, remainingHpForTile } from '../tileHp.js';
import { tickSmartAi, type AiDifficulty } from './ai.js';

export type { AiDifficulty } from './ai.js';
export { AI_ACTION_DELAY_SEC, AI_DIFFICULTIES } from './ai.js';
export { WORKER_HOLD_MS, WORKER_HOLD_SECONDS } from '../bees.js';
import type {
  ActivityEntry,
  FlowerPatch,
  FreedLetter,
  GameCommand,
  OpponentSlot,
  Petal,
  PlayerState,
  QueenAttackSide,
  Side,
  TileSnapshot,
  WorldPhase,
  WorldSnapshot,
} from '../messages.js';
import type { HiveAssaultPanel, OpponentHivePanel } from '../bees.js';

export type { ActivityEntry, OpponentSlot, QueenAttackSide, Side, WorldPhase } from '../messages.js';

export const MAX_PLAYERS = 4;

export interface World {
  readonly t: number;
  readonly phase: WorldPhase;
  /** Fixed join-order roster for the match. */
  readonly playerIds: readonly string[];
  readonly players: Readonly<Record<string, PlayerState>>;
  /** Players still in the match (not eliminated). */
  readonly activePlayerIds: readonly string[];
  readonly eliminatedPlayerIds: readonly string[];
  readonly winnerId: string | null;
  readonly patches: readonly FlowerPatch[];
  readonly patchCooldown: number;
  readonly playerCount: number;
  readonly aiWorkerCooldown: number;
  readonly aiPlaceCooldown: number;
  readonly aiPhantomCooldown: number;
  readonly aiCarpenterCooldown: number;
  /** Solo opponent pacing; ignored in online PvP. */
  readonly aiDifficulty: AiDifficulty;
  /** Seconds until the CPU may take its next action burst (difficulty gate). */
  readonly aiActionDelay: number;
  /** Easy/medium: petal hex the CPU is "holding" before dispatching a worker. */
  readonly aiWorkerHoldHex: Hex | null;
  /** Elapsed hold time toward {@link WORKER_HOLD_SECONDS} for {@link aiWorkerHoldHex}. */
  readonly aiWorkerHoldElapsed: number;
  readonly log: readonly ActivityEntry[];
}

export type BuildInitialWorldConfig = {
  readonly aiDifficulty?: AiDifficulty;
};

export type BuildInitialWorldIds =
  | { readonly playerIds: readonly string[] }
  | { readonly selfId: string; readonly opponentId: string };

// ---- Constants -------------------------------------------------------------

/** Initial radius of the player hive (rings 0..2 are seeded). Carpenters grow
 *  the hive outward beyond this without bound. */
export const HIVE_RADIUS = 2;
/** Letter-storage slots seeded at hive ring 1 in {@link buildPlayer}. */
const STORAGE_SLOT_COUNT = 6;
/** Radius of the central flower field. Larger than before to fit 3 patches
 *  (each is 7 hexes) with enough breathing room. */
export const FIELD_RADIUS = 4;
/** Base number of flower patches at 2 players; see {@link patchTargetForPlayers}. */
export const PATCH_TARGET_COUNT = 3;
/** Extra flower patches spawned when a bee-related word triggers pollen bloom. */
export const POLLEN_BLOOM_PATCH_COUNT = 3;

/** Scale core flower patch count with player count: 2p→3, 3p→4, 4p→5. */
export const patchTargetForPlayers = (n: number): number =>
  PATCH_TARGET_COUNT + Math.max(0, n - 2);

/** Scale pollen-bloom bonus patches with player count. */
export const pollenBloomPatchCountForPlayers = (n: number): number =>
  POLLEN_BLOOM_PATCH_COUNT + Math.max(0, n - 2);
/** How long after a patch despawns before a new one can spawn. */
export const PATCH_RESPAWN_SECONDS = 1.5;
/** Total intended lifetime of a freshly spawned patch (seconds). */
export const PATCH_LIFETIME_SECONDS = 28;
/** Two patch centers must be at least this many hexes apart so their petal
 *  rings don't overlap. */
export const PATCH_MIN_CENTER_DISTANCE = 3;
export const QUEEN_ASSAULT_DURATION_SECONDS = 3;
export const QUEEN_LIFETIME_SECONDS = QUEEN_ASSAULT_DURATION_SECONDS;
/** Seconds between queen strikes / steps during {@link BeeState} `queen-assault`. */
export const QUEEN_ACTION_INTERVAL_SECONDS = 0.5;
/** Damage dealt to a hex per queen strike (during {@link BeeState} `queen-assault`). */
export const QUEEN_DAMAGE_PER_STRIKE = 0.25;
const FREED_LETTER_LIFETIME_SECONDS = 6;
const LOG_MAX_ENTRIES = 14;
const PATCH_TYPES: readonly FlowerType[] = ['vowel', 'common', 'rare'];

const AI_WORKER_BASE = 2;
const AI_PLACE_BASE = 1;
const AI_PHANTOM_BASE = 4;
const AI_CARPENTER_BASE = 8;

// ---- Construction ----------------------------------------------------------

const ringIndex = (h: Hex): number =>
  Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r));

const cubeDistance = (a: Hex, b: Hex): number => {
  const az = -a.q - a.r;
  const bz = -b.q - b.r;
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(az - bz)) / 2;
};

/** Outermost owned landable ring: touches at least one hex outside the defender's blob. */
export const queenPerimeterLandingHexKeys = (defender: PlayerState): Set<string> => {
  const owned = new Set(defender.tiles.map((t) => hexKey(t.hex)));
  const out = new Set<string>();
  for (const t of defender.tiles) {
    if (t.state === 'hive' || t.state === 'inactive') continue;
    if (neighbors(t.hex).some((n) => !owned.has(hexKey(n)))) {
      out.add(hexKey(t.hex));
    }
  }
  return out;
};

/** Pixel hex radius used to classify {@link QueenAttackSide} (match main hive SVG). */
const QUEEN_ATTACK_SIDE_HEX_SIZE = 30;

/**
 * Among the defender's queen perimeter tiles, pick the landing hex on the given
 * {@link QueenAttackSide}: filter to tiles on that half of the hive (positive
 * dot product with the side direction in pixel space), then pick the *weakest*
 * point — closest to the hive center first, then lowest remaining HP, then
 * {@link hexKey} order for stability.
 */
export const pickQueenLandingHexForSide = (
  defender: PlayerState,
  attackSide: QueenAttackSide,
  hexSize = QUEEN_ATTACK_SIDE_HEX_SIZE,
): Hex | null => {
  const ring = queenPerimeterLandingHexKeys(defender);
  const perimeterTiles = defender.tiles.filter(
    (t) => ring.has(hexKey(t.hex)) && t.state !== 'hive' && t.state !== 'inactive',
  );
  if (perimeterTiles.length === 0) return null;

  const origin = hex(0, 0);
  const dir =
    attackSide === 'top'
      ? { x: 0, y: -1 }
      : attackSide === 'right'
        ? { x: 1, y: 0 }
        : attackSide === 'bottom'
          ? { x: 0, y: 1 }
          : { x: -1, y: 0 };

  const scored = perimeterTiles.map((t) => {
    const { x, y } = axialToPixel(t.hex, hexSize);
    const dot = x * dir.x + y * dir.y;
    const d = cubeDistance(t.hex, origin);
    const hp = remainingHpForTile(t);
    return { t, dot, d, hp };
  });

  // Keep only tiles on the chosen side (positive dot product).
  const onSide = scored.filter((s) => s.dot > 1e-9);
  const pool = onSide.length > 0 ? onSide : scored;

  // Weakest point: closest to center first, then lowest HP, then hexKey.
  pool.sort((a, b) => {
    const dd = a.d - b.d;
    if (dd !== 0) return dd;
    const hpDiff = a.hp - b.hp;
    if (hpDiff !== 0) return hpDiff;
    return hexKey(a.t.hex).localeCompare(hexKey(b.t.hex));
  });
  return pool[0]!.t.hex;
};

/** Weakest perimeter hex on the defender — closest to center, then lowest HP. */
const pickQueenLandingHex = (defender: PlayerState): Hex | null => {
  const ring = queenPerimeterLandingHexKeys(defender);
  const candidates = defender.tiles.filter((t) => ring.has(hexKey(t.hex)));
  if (candidates.length === 0) return null;
  return candidates
    .sort((a, b) => {
      const da = cubeDistance(a.hex, hex(0, 0));
      const db = cubeDistance(b.hex, hex(0, 0));
      if (da !== db) return da - db;
      const hpDiff = remainingHpForTile(a) - remainingHpForTile(b);
      if (hpDiff !== 0) return hpDiff;
      return hexKey(a.hex).localeCompare(hexKey(b.hex));
    })[0]!.hex;
};

/** Defender hex the queen may land on — any owned non-hive tile (in-flight retarget checks). */
const isQueenLandingHex = (defender: PlayerState, h: Hex): boolean =>
  defender.tiles.some(
    (t) => hexEquals(t.hex, h) && t.state !== 'hive' && t.state !== 'inactive',
  );

/** Player-chosen spawn target: outer ring only (matches {@link pickQueenLandingHex} set). */
const isQueenSpawnTargetHex = (defender: PlayerState, h: Hex): boolean =>
  isQueenLandingHex(defender, h) && queenPerimeterLandingHexKeys(defender).has(hexKey(h));

const pickQueenPerimeterLanding = (
  defender: PlayerState,
  attackSide?: QueenAttackSide,
): Hex | null =>
  attackSide !== undefined
    ? pickQueenLandingHexForSide(defender, attackSide)
    : pickQueenLandingHex(defender);

/** Inward void cells beside `landing` at queen dispatch (for rebuild retarget). */
export const queenApproachVoidHexKeys = (
  defender: PlayerState,
  landing: Hex,
): readonly string[] => {
  const origin = hex(0, 0);
  const landingDist = cubeDistance(landing, origin);
  const tileByKey = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
  const keys: string[] = [];
  for (const n of neighbors(landing)) {
    if (tileByKey.has(hexKey(n))) continue;
    if (cubeDistance(n, origin) >= landingDist) continue;
    keys.push(hexKey(n));
  }
  return keys;
};

/**
 * While a queen is in flight, re-evaluate the landing hex as the defender board
 * changes. Picks a deeper corridor tile when one opens (destroyed tile) or when
 * a landable tile is rebuilt on the ingress path (so the queen does not fly over
 * it). Falls back to the current hex when it remains best.
 */
export const pickQueenLandingHexWhileFlying = (
  defender: PlayerState,
  currentLanding: Hex,
  attackSide?: QueenAttackSide,
  approachVoidHexKeys?: readonly string[],
): Hex | null => {
  if (!isQueenLandingHex(defender, currentLanding)) {
    return pickQueenPerimeterLanding(defender, attackSide);
  }

  const origin = hex(0, 0);
  const currentDist = cubeDistance(currentLanding, origin);

  if (approachVoidHexKeys && approachVoidHexKeys.length > 0) {
    const tileByKey = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
    let rebuilt: Hex | null = null;
    let rebuiltDist = currentDist;
    for (const k of approachVoidHexKeys) {
      const tile = tileByKey.get(k);
      if (!tile || !isQueenLandingHex(defender, tile.hex)) continue;
      const d = cubeDistance(tile.hex, origin);
      if (d < rebuiltDist) {
        rebuiltDist = d;
        rebuilt = tile.hex;
      }
    }
    if (rebuilt) return rebuilt;
  }

  const corridor = pickIngressLandableOnCorridor(defender, currentLanding);
  if (corridor) {
    const corridorDist = cubeDistance(corridor, origin);
    const adjacent = neighbors(currentLanding).some((n) => hexEquals(n, corridor));
    if (
      corridorDist < currentDist &&
      !adjacent &&
      hasVoidIngressPath(defender, currentLanding, corridor)
    ) {
      return corridor;
    }
  }

  return currentLanding;
};

/** Innermost landable tile reachable from `from` through void + landable steps inward. */
const pickIngressLandableOnCorridor = (defender: PlayerState, from: Hex): Hex | null => {
  const origin = hex(0, 0);
  const fromDist = cubeDistance(from, origin);
  const tileByKey = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
  const maxHullRadius = defender.tiles.reduce(
    (m, t) => Math.max(m, cubeDistance(t.hex, origin)),
    0,
  );
  /** Only explore void within a thin shell around the hive blob (not the whole axial plane). */
  const maxVoidReach = maxHullRadius + 4;
  const visitBudget = Math.min(2_000, defender.tiles.length * 24 + 128);

  const dist = new Map<string, number>();
  dist.set(hexKey(from), 0);
  const q: Hex[] = [from];
  let best: Hex | null = null;
  let bestCenterDist = fromDist;
  let visits = 0;

  while (q.length > 0 && visits < visitBudget) {
    visits++;
    const cur = q.shift()!;
    const curKey = hexKey(cur);
    const curSteps = dist.get(curKey)!;

    if (isQueenLandingHex(defender, cur) && curSteps > 0) {
      const d = cubeDistance(cur, origin);
      if (d < bestCenterDist) {
        bestCenterDist = d;
        best = cur;
      }
    }

    for (const nbr of neighbors(cur)) {
      const nk = hexKey(nbr);
      if (dist.has(nk)) continue;
      const tile = tileByKey.get(nk);
      if (tile) {
        if (!isQueenLandingHex(defender, nbr)) continue;
      } else if (cubeDistance(nbr, origin) > maxVoidReach) {
        continue;
      }
      dist.set(nk, curSteps + 1);
      q.push(nbr);
    }
  }

  return best;
};

/** True when `to` is reachable from void cells adjacent to `from` (rebuilt breach tile). */
const hasVoidIngressPath = (defender: PlayerState, from: Hex, to: Hex): boolean => {
  const tileByKey = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
  const isVoid = (h: Hex): boolean => !tileByKey.has(hexKey(h));
  const seen = new Set<string>();
  const q: Hex[] = [];
  for (const n of neighbors(from)) {
    if (!isVoid(n)) continue;
    const nk = hexKey(n);
    seen.add(nk);
    q.push(n);
  }
  const maxVoidReach =
    defender.tiles.reduce((m, t) => Math.max(m, cubeDistance(t.hex, hex(0, 0))), 0) + 4;
  let steps = 0;
  while (q.length > 0 && steps < 512) {
    steps++;
    const cur = q.shift()!;
    if (hexEquals(cur, to)) return true;
    for (const nbr of neighbors(cur)) {
      if (hexEquals(nbr, to)) return true;
      const nk = hexKey(nbr);
      if (seen.has(nk) || !isVoid(nbr)) continue;
      if (cubeDistance(nbr, hex(0, 0)) > maxVoidReach) continue;
      seen.add(nk);
      q.push(nbr);
    }
  }
  return false;
};

const buildPlayer = (id: string): PlayerState => {
  const tiles: TileSnapshot[] = [];
  for (const h of range(hex(0, 0), HIVE_RADIUS)) {
    const ri = ringIndex(h);
    if (ri === 0) tiles.push({ hex: h, state: 'hive', letter: null, reuseCount: 0, damage: 0 });
    else if (ri === 1) tiles.push({ hex: h, state: 'storage', letter: null, reuseCount: 0, damage: 0 });
    else tiles.push({ hex: h, state: 'active', letter: null, reuseCount: 0, damage: 0 });
  }
  return {
    id,
    honey: HIVE.startingHoney,
    tiles,
    freedLetters: [],
    bees: [],
    usedWordSignatures: [],
    bestWord: '',
    bestWordScore: 0,
  };
};

/**
 * Per-second honey regeneration. Every owned hex contributes
 * {@link HIVE.regenPerHex}; each capped letter adds an additional
 * {@link HIVE.cappedHoneyBonus} on top so locking in words pays back as
 * sustained production, not just one-shot word bonuses.
 */
export const honeyRateFor = (player: PlayerState): number => {
  let cappedCount = 0;
  for (const t of player.tiles) if (t.state === 'capped') cappedCount += 1;
  return HIVE.regenPerHex * player.tiles.length + HIVE.cappedHoneyBonus * cappedCount;
};

/**
 * How many queens a player may have simultaneously airborne or assaulting.
 * One by default, plus one extra per full {@link HEXES_PER_QUEEN_SLOT} owned
 * hexes — bigger hives get to field swarms.
 */
export const queenAllowanceFor = (player: PlayerState): number =>
  1 + Math.floor(player.tiles.length / HEXES_PER_QUEEN_SLOT);

/** Count the player's queens currently in flight or mid-assault. */
export const activeQueenCountFor = (player: PlayerState): number => {
  let n = 0;
  for (const b of player.bees) {
    if (b.state.kind === 'queen-flying' || b.state.kind === 'queen-assault') n += 1;
  }
  return n;
};

/**
 * Honey storage cap: the central hive contributes {@link HIVE.hiveStorage}
 * and every other owned tile (active / letter / capped / legacy inactive)
 * contributes 1, *except* letter-storage slots which contribute 0. Storage
 * slots are not honeycomb — they're delivery cubbies for unplaced letters.
 *
 * Filling a tile with a letter does not shrink the cap; only losing a tile
 * (e.g. queen destruction) does.
 */
export const honeyCapFor = (player: PlayerState): number => {
  let cap = 0;
  for (const t of player.tiles) {
    if (t.state === 'hive') cap += HIVE.hiveStorage;
    else if (t.state === 'storage') continue;
    else cap += 1;
  }
  return cap;
};

/** Add `bonus` honey to `player`, clamped at their current cap. */
const grantHoney = (player: PlayerState, bonus: number): PlayerState => ({
  ...player,
  honey: Math.min(honeyCapFor(player), player.honey + bonus),
});

/**
 * The set of hexes the player could activate next: any hex adjacent to one of
 * their `active`/`letter`/`capped` tiles that they don't already own. Derived
 * from {@link PlayerState.tiles}; the engine never stores frontier tiles
 * itself, so the hive can grow unbounded.
 */
export const frontierFor = (player: PlayerState): readonly Hex[] => {
  const owned = new Set(player.tiles.map((t) => hexKey(t.hex)));
  const frontier = new Map<string, Hex>();
  for (const t of player.tiles) {
    if (t.state !== 'active' && t.state !== 'letter' && t.state !== 'capped') continue;
    for (const n of neighbors(t.hex)) {
      const k = hexKey(n);
      if (!owned.has(k)) frontier.set(k, n);
    }
  }
  return [...frontier.values()];
};

// ---- Flower patches --------------------------------------------------------

/** Hex centers where a 6-petal patch can fit entirely inside the field. */
const patchCenterCandidates: readonly Hex[] = range(hex(0, 0), FIELD_RADIUS).filter(
  (h) => neighbors(h).every((n) => ringIndex(n) <= FIELD_RADIUS),
);

const patchOccupiedHexKeys = (patches: readonly FlowerPatch[]): Set<string> => {
  const keys = new Set<string>();
  for (const p of patches) {
    keys.add(hexKey(p.center));
    for (const pt of p.petals) keys.add(hexKey(pt.hex));
  }
  return keys;
};

const patchFitsWithoutOverlap = (occupied: ReadonlySet<string>, center: Hex): boolean => {
  if (occupied.has(hexKey(center))) return false;
  for (const h of neighbors(center)) {
    if (occupied.has(hexKey(h))) return false;
  }
  return true;
};

const freePatchCenters = (
  existing: readonly FlowerPatch[],
  opts?: { readonly pollenBloom?: boolean },
): readonly Hex[] => {
  if (opts?.pollenBloom) {
    const occupied = patchOccupiedHexKeys(existing);
    return patchCenterCandidates.filter((c) => patchFitsWithoutOverlap(occupied, c));
  }
  return patchCenterCandidates.filter((c) =>
    existing.every((p) => cubeDistance(p.center, c) >= PATCH_MIN_CENTER_DISTANCE),
  );
};

/**
 * Spawn a single patch of the requested type at one of the available center
 * candidates. Returns null if every candidate is too close to an existing
 * patch (no room to bloom). Type is chosen by the caller so the field can
 * maintain its 1-of-each invariant; see {@link missingPatchTypes} and
 * {@link seedPatches}. Pollen-bloom patches use tighter non-overlapping
 * placement so three can usually fit alongside the core field.
 */
const spawnPatch = (
  existing: readonly FlowerPatch[],
  type: FlowerType,
  rng: () => number,
  spawnedAt: number,
  opts?: { readonly pollenBloom?: boolean },
): FlowerPatch | null => {
  const free = freePatchCenters(existing, opts);
  if (free.length === 0) return null;
  const center = free[Math.floor(rng() * free.length)]!;
  // Spread petal wither times across [0.45, 1.0] of lifetime in random order so
  // the visual decay has organic timing.
  const order = neighbors(center)
    .map((h, i) => ({ h, i, sort: rng() }))
    .sort((a, b) => a.sort - b.sort)
    .map((x) => x.h);
  const petals: Petal[] = order.map((h, i) => ({
    hex: h,
    letter: drawFlowerLetter(type, rng),
    witherAt:
      spawnedAt +
      PATCH_LIFETIME_SECONDS *
        (0.45 + (0.55 * (i + 1)) / order.length) +
      (rng() - 0.5) * 1.2,
  }));
  return {
    id: newId(),
    type,
    center,
    petals,
    spawnedAt,
    lifetimeSeconds: PATCH_LIFETIME_SECONDS,
    ...(opts?.pollenBloom ? { pollenBloom: true as const } : {}),
  };
};

/** One pickable petal when a full six-petal patch will not fit. */
const spawnSinglePetalBloom = (
  existing: readonly FlowerPatch[],
  type: FlowerType,
  rng: () => number,
  spawnedAt: number,
): FlowerPatch | null => {
  const occupied = patchOccupiedHexKeys(existing);
  const slots: { readonly center: Hex; readonly petal: Hex }[] = [];
  for (const center of patchCenterCandidates) {
    if (occupied.has(hexKey(center))) continue;
    for (const petalHex of neighbors(center)) {
      if (ringIndex(petalHex) > FIELD_RADIUS) continue;
      if (occupied.has(hexKey(petalHex))) continue;
      slots.push({ center, petal: petalHex });
    }
  }
  if (slots.length === 0) return null;
  const pick = slots[Math.floor(rng() * slots.length)]!;
  return {
    id: newId(),
    type,
    center: pick.center,
    petals: [
      {
        hex: pick.petal,
        letter: drawFlowerLetter(type, rng),
        witherAt:
          spawnedAt +
          PATCH_LIFETIME_SECONDS * (0.75 + rng() * 0.25) +
          (rng() - 0.5) * 1.2,
      },
    ],
    spawnedAt,
    lifetimeSeconds: PATCH_LIFETIME_SECONDS,
    pollenBloom: true,
  };
};

/** Spawn bonus patches for a pollen bloom (scaled by player count). */
const spawnPollenBloomPatches = (
  existing: readonly FlowerPatch[],
  rng: () => number,
  spawnedAt: number,
  playerCount: number,
): readonly FlowerPatch[] => {
  const target = pollenBloomPatchCountForPlayers(playerCount);
  const added: FlowerPatch[] = [];
  let patches = [...existing];
  const types = [...PATCH_TYPES];
  while (added.length < target) {
    const type = types[added.length % types.length]!;
    let fresh = spawnPatch(patches, type, rng, spawnedAt, { pollenBloom: true });
    if (!fresh) fresh = spawnSinglePetalBloom(patches, type, rng, spawnedAt);
    if (!fresh) break;
    patches = [...patches, fresh];
    added.push(fresh);
  }
  return added;
};

/** Core field patches — excludes pollen-bloom bonuses. */
const corePatches = (patches: readonly FlowerPatch[]): readonly FlowerPatch[] =>
  patches.filter((p) => !p.pollenBloom);

/** Which of the three patch types are not currently present in the core field. */
const missingPatchTypes = (patches: readonly FlowerPatch[]): FlowerType[] => {
  const present = new Set(corePatches(patches).map((p) => p.type));
  return PATCH_TYPES.filter((t) => !present.has(t));
};

/** How many core patches the field should maintain for the given player count. */
const corePatchTarget = (patches: readonly FlowerPatch[], playerCount: number): number =>
  patchTargetForPlayers(playerCount);

/** Extra core patch types needed beyond the 1-of-each invariant. */
const extraCorePatchTypesNeeded = (
  patches: readonly FlowerPatch[],
  playerCount: number,
): FlowerType[] => {
  const core = corePatches(patches);
  const target = corePatchTarget(patches, playerCount);
  if (core.length >= target) return [];
  const missing = missingPatchTypes(patches);
  if (missing.length > 0) return missing;
  const counts = new Map<FlowerType, number>();
  for (const t of PATCH_TYPES) counts.set(t, 0);
  for (const p of core) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  const extras: FlowerType[] = [];
  while (core.length + extras.length < target) {
    let pick: FlowerType = PATCH_TYPES[0]!;
    let min = counts.get(pick) ?? 0;
    for (const t of PATCH_TYPES) {
      const c = counts.get(t) ?? 0;
      if (c < min) {
        min = c;
        pick = t;
      }
    }
    extras.push(pick);
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
  }
  return extras;
};

/** Seed the initial field; maintains 1-of-each then fills to player-scaled quota. */
const seedPatches = (rng: () => number, t: number, playerCount: number): FlowerPatch[] => {
  let result: FlowerPatch[] = [];
  for (const type of PATCH_TYPES) {
    const p = spawnPatch(result, type, rng, t);
    if (!p) break;
    result.push(p);
  }
  for (const type of extraCorePatchTypesNeeded(result, playerCount)) {
    const p = spawnPatch(result, type, rng, t);
    if (p) result.push(p);
  }
  return result;
};

/** Find the patch + petal that lives on a given hex, if any. */
export const petalAt = (
  patches: readonly FlowerPatch[],
  h: Hex,
): { patch: FlowerPatch; petal: Petal } | null => {
  for (const patch of patches) {
    const petal = patch.petals.find((p) => hexEquals(p.hex, h));
    if (petal) return { patch, petal };
  }
  return null;
};

/** Remove one petal (by hex) from a patch list and drop empty patches. */
const removePetal = (
  patches: readonly FlowerPatch[],
  patchId: string,
  petalHex: Hex,
): readonly FlowerPatch[] =>
  patches
    .map((p) =>
      p.id === patchId
        ? { ...p, petals: p.petals.filter((pt) => !hexEquals(pt.hex, petalHex)) }
        : p,
    )
    .filter((p) => p.petals.length > 0);

/**
 * Build a fresh world. Pass player ids in join order for multiplayer, or
 * `{ selfId, opponentId }` for solo / legacy 2-player tests.
 */
export const buildInitialWorld = (
  rng: () => number,
  ids: BuildInitialWorldIds = { selfId: 'self', opponentId: 'opponent' },
  config: BuildInitialWorldConfig = {},
): World => {
  const playerIds =
    'playerIds' in ids ? [...ids.playerIds] : [ids.selfId, ids.opponentId];
  const players: Record<string, PlayerState> = {};
  for (const id of playerIds) {
    players[id] = buildPlayer(id);
  }
  const playerCount = playerIds.length;
  return {
    t: 0,
    phase: 'playing',
    playerIds,
    players,
    activePlayerIds: [...playerIds],
    eliminatedPlayerIds: [],
    winnerId: null,
    patches: seedPatches(rng, 0, playerCount),
    patchCooldown: PATCH_RESPAWN_SECONDS,
    playerCount,
    aiWorkerCooldown: AI_WORKER_BASE,
    aiPlaceCooldown: AI_PLACE_BASE,
    aiPhantomCooldown: AI_PHANTOM_BASE,
    aiCarpenterCooldown: AI_CARPENTER_BASE,
    aiDifficulty: config.aiDifficulty ?? 'medium',
    aiActionDelay: 0,
    aiWorkerHoldHex: null,
    aiWorkerHoldElapsed: 0,
    log: [],
  };
};

// ---- Player helpers --------------------------------------------------------

export const joinIndexOf = (world: World, playerId: string): number =>
  world.playerIds.indexOf(playerId);

export const getPlayer = (world: World, playerId: string): PlayerState =>
  world.players[playerId]!;

export const setPlayerById = (
  world: World,
  playerId: string,
  player: PlayerState,
): World => ({
  ...world,
  players: { ...world.players, [playerId]: player },
});

/** Solo / legacy shim: first player is canonical `'self'`, second is `'opponent'`. */
export const sideForPlayerId = (world: World, playerId: string): Side | null => {
  const idx = joinIndexOf(world, playerId);
  if (idx === 0) return 'self';
  if (idx === 1 && world.playerIds.length === 2) return 'opponent';
  return null;
};

export const playerIdForSide = (world: World, side: Side): string =>
  side === 'self' ? world.playerIds[0]! : world.playerIds[1]!;

export const opponentSlotForJoinIndex = (joinIndex: number): OpponentSlot => {
  if (joinIndex === 2) return 'above';
  if (joinIndex === 3) return 'below';
  return 'right';
};

export const opponentHivePanelForJoinIndex = (joinIndex: number): OpponentHivePanel => {
  if (joinIndex === 2) return 'opponent-hive-above';
  if (joinIndex === 3) return 'opponent-hive-below';
  return 'opponent-hive-right';
};

export const hivePanelForPlayer = (world: World, playerId: string): HiveAssaultPanel => {
  const idx = joinIndexOf(world, playerId);
  if (idx <= 0) return 'self-hive';
  return opponentHivePanelForJoinIndex(idx);
};

export const viewerHivePanel = (
  world: World,
  viewerId: string,
  playerId: string,
): HiveAssaultPanel => {
  if (playerId === viewerId) return 'self-hive';
  return opponentHivePanelForJoinIndex(joinIndexOf(world, playerId));
};

const playerIdForCanonicalPanel = (world: World, panel: BeePanel): string | null => {
  if (panel === 'flowers') return null;
  if (panel === 'self-hive') return world.playerIds[0] ?? null;
  if (panel === 'opponent-hive' || panel === 'opponent-hive-right') {
    return world.playerIds[1] ?? null;
  }
  if (panel === 'opponent-hive-above') return world.playerIds[2] ?? null;
  if (panel === 'opponent-hive-below') return world.playerIds[3] ?? null;
  return null;
};

const remapBeePanelForViewer = (
  world: World,
  viewerId: string,
  panel: BeePanel,
): BeePanel => {
  if (panel === 'flowers') return 'flowers';
  const ownerId = playerIdForCanonicalPanel(world, panel);
  if (!ownerId) return panel;
  const relative = viewerHivePanel(world, viewerId, ownerId);
  return relative === 'self-hive' ? 'self-hive' : relative;
};

/** Solo / 2-player: the second roster slot. */
export const secondPlayer = (world: World): PlayerState =>
  getPlayer(world, world.playerIds[1] ?? 'opponent');

export const getActiveOpponentsOf = (
  world: World,
  viewerId: string,
): readonly { readonly player: PlayerState; readonly slot: OpponentSlot }[] => {
  const slotOrder: OpponentSlot[] = ['right', 'above', 'below'];
  return world.activePlayerIds
    .filter((id) => id !== viewerId)
    .map((id) => ({
      player: getPlayer(world, id),
      slot: opponentSlotForJoinIndex(joinIndexOf(world, id)),
    }))
    .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));
};

/** All non-viewer roster slots (active and eliminated) for snapshots and board navigation. */
export const getRivalsOf = (
  world: World,
  viewerId: string,
): readonly { readonly player: PlayerState; readonly slot: OpponentSlot }[] => {
  const slotOrder: OpponentSlot[] = ['right', 'above', 'below'];
  return world.playerIds
    .filter((id) => id !== viewerId)
    .map((id) => ({
      player: getPlayer(world, id),
      slot: opponentSlotForJoinIndex(joinIndexOf(world, id)),
    }))
    .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));
};

const setPlayer = (world: World, side: Side, player: PlayerState): World =>
  setPlayerById(world, playerIdForSide(world, side), player);

const otherSide = (side: Side): Side => (side === 'self' ? 'opponent' : 'self');

const sideHivePanel = (world: World, side: Side): HiveAssaultPanel =>
  hivePanelForPlayer(world, playerIdForSide(world, side));

const logEvent = (world: World, entry: Omit<ActivityEntry, 'id'>): World => ({
  ...world,
  log: [{ ...entry, id: newId() }, ...world.log].slice(0, LOG_MAX_ENTRIES),
});

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Math.random().toString(36).slice(2, 10);
};

const tickHoney = (player: PlayerState, dt: number): PlayerState => ({
  ...player,
  honey: Math.min(honeyCapFor(player), player.honey + honeyRateFor(player) * dt),
});

const flight = (
  fromPanel: BeeWaypoint['panel'],
  fromHex: Hex,
  toPanel: BeeWaypoint['panel'],
  toHex: Hex,
  startedAt: number,
  duration: number,
): BeeFlight => ({
  from: { panel: fromPanel, hex: fromHex },
  to: { panel: toPanel, hex: toHex },
  startedAt,
  arrivesAt: startedAt + duration,
});

/**
 * Pick the first empty storage slot (radius 1, state='storage', letter=null).
 * We iterate in axial order so deliveries fill predictably from the same place
 * each time — players can rely on a stable visual grouping.
 */
const pickEmptyStorage = (player: PlayerState): TileSnapshot | null => {
  for (const t of player.tiles) {
    if (t.state === 'storage' && !t.letter) return t;
  }
  return null;
};

// ---- Top-level tick --------------------------------------------------------

export interface TickOptions {
  /**
   * Skip RNG-driven simulation steps that the server owns authoritatively.
   * Set this when running {@link tickWorld} as client-side prediction in
   * online mode: the next `SNAPSHOT` will replace `patches` and freed letters
   * wholesale, so simulating them locally with a desynchronized RNG only
   * produces visible flicker (e.g. flowers spawning at a different position
   * than the server picked, then snapping back when the snapshot arrives).
   *
   * Deterministic work — engine clock, honey trickle, bee arrivals, queen
   * damage timing — still runs so animations stay smooth between snapshots.
   */
  readonly clientPrediction?: boolean;
}

/**
 * Advance the world by `dt` seconds with no AI. The server calls this for
 * authoritative simulation; solo clients compose with {@link tickSoloAi};
 * online clients pass `{ clientPrediction: true }` between snapshots.
 */
export const tickWorld = (
  world: World,
  dt: number,
  rng: () => number,
  opts: TickOptions = {},
): World => {
  if (world.phase === 'over') return world;
  let next: World = { ...world, t: world.t + dt };
  for (const playerId of world.activePlayerIds) {
    next = setPlayerById(next, playerId, tickHoney(getPlayer(next, playerId), dt));
  }
  next = resolveArrivedBees(next, opts.clientPrediction ? undefined : rng);
  next = tickQueens(next);
  next = tickFreedLetters(next);
  // Patch wither/spawn lives server-side in online mode — the snapshot will
  // overwrite `patches`, and locally-simulated spawns desync from the
  // server's RNG, causing flickering flower positions.
  if (!opts.clientPrediction) {
    next = tickPatches(next, dt, rng);
  }
  return next;
};

/** Solo wrapper: sim + smart AI opponent in one call. */
export const tickSolo = (world: World, dt: number, rng: () => number): World =>
  tickSmartAi(tickWorld(world, dt, rng), dt, rng);

const tickFreedLetters = (world: World): World => {
  const trim = (letters: readonly FreedLetter[]) => letters.filter((l) => l.witherAt > world.t);
  let next = world;
  let changed = false;
  for (const playerId of world.activePlayerIds) {
    const player = getPlayer(next, playerId);
    const current = player.freedLetters ?? [];
    const trimmed = trim(current);
    if (trimmed.length !== current.length) {
      next = setPlayerById(next, playerId, { ...player, freedLetters: trimmed });
      changed = true;
    }
  }
  return changed ? next : world;
};

/**
 * Wither petals whose `witherAt` has elapsed, drop empty patches, and respawn
 * any patch type that's missing from the field. The field maintains a strict
 * 1-of-each invariant — vowel + common + rare — so when a patch dies the
 * cooldown cycle replaces it with the same type that just disappeared.
 * If multiple patches die in quick succession, types are refilled one per
 * cycle so deaths visibly stagger.
 */
const tickPatches = (world: World, dt: number, rng: () => number): World => {
  const wilted: { type: FlowerType; letter: Letter }[] = [];
  let patches: FlowerPatch[] = world.patches.map((p) => {
    const surviving = p.petals.filter((pt) => pt.witherAt > world.t);
    for (const pt of p.petals) {
      if (!surviving.includes(pt)) wilted.push({ type: p.type, letter: pt.letter });
    }
    return { ...p, petals: surviving };
  });
  patches = patches.filter((p) => p.petals.length > 0);

  let cooldown = world.patchCooldown - dt;
  const missing = missingPatchTypes(patches);
  const extrasNeeded = extraCorePatchTypesNeeded(patches, world.playerCount);
  const typesToSpawn = missing.length > 0 ? missing : extrasNeeded;
  if (typesToSpawn.length > 0) {
    if (cooldown <= 0) {
      const type = typesToSpawn[Math.floor(rng() * typesToSpawn.length)]!;
      const fresh = spawnPatch(patches, type, rng, world.t);
      if (fresh) {
        patches = [...patches, fresh];
        cooldown = PATCH_RESPAWN_SECONDS;
      }
    }
  } else if (corePatches(patches).length >= corePatchTarget(patches, world.playerCount)) {
    cooldown = PATCH_RESPAWN_SECONDS;
  }
  let next: World = { ...world, patches, patchCooldown: cooldown };
  if (wilted.length > 0) {
    // One log line per tick so we don't spam the activity feed.
    const summary = wilted
      .slice(0, 3)
      .map((w) => w.letter)
      .join(',');
    next = logEvent(next, {
      t: next.t,
      ownerId: 'field',
      text: `${summary}${wilted.length > 3 ? '…' : ''} withered`,
    });
  }
  return next;
};

/**
 * Honeycomb tiles that can appear in a word path for drone capping (excludes
 * storage slots, which also carry letters but are not on the comb).
 */
export function tileHasDraftableLetter(
  tile: TileSnapshot | undefined,
): tile is TileSnapshot & { letter: Letter } {
  return (
    !!tile?.letter &&
    (tile.state === 'capped' ||
      tile.state === 'letter' ||
      (tile.state === 'active' && !!tile.letter))
  );
}

// ---- Bee resolution --------------------------------------------------------

const resolveArrivedBees = (world: World, rng?: () => number): World => {
  let next = world;
  for (const playerId of world.activePlayerIds) {
    next = resolvePlayerBees(next, playerId, rng);
  }
  return next;
};

const resolvePlayerBees = (world: World, playerId: string, rng?: () => number): World => {
  const player = getPlayer(world, playerId);
  const hivePanel = hivePanelForPlayer(world, playerId);
  let next = world;
  let updatedPlayer = player;
  let updatedPatches = world.patches;
  let beesChanged = false;
  const remainingBees: Bee[] = [];
  /** Hex keys already targeted by an in-flight carpenter (avoid duplicate flights). */
  const reservedCarpenterTargets = new Set<string>();
  for (const b of player.bees) {
    if (b.state.kind === 'carpenter-flying') {
      reservedCarpenterTargets.add(hexKey(b.state.target));
      for (const qh of b.state.queue) reservedCarpenterTargets.add(hexKey(qh));
    }
  }

  for (const bee of player.bees) {
    const arrival = arrivalOf(bee);
    if (arrival === null || arrival > world.t) {
      if (
        bee.state.kind === 'queen-flying' &&
        (!Number.isFinite(bee.state.expiresAt) || world.t >= bee.state.expiresAt)
      ) {
        beesChanged = true;
        continue;
      }
      if (bee.state.kind === 'queen-flying') {
        const defender = getPlayer(world, bee.state.defenderPlayerId);
        const f = bee.state.flight;
        const landing = bee.state.landingHex;
        const desired =
          pickQueenLandingHexWhileFlying(
            defender,
            landing,
            bee.state.attackSide,
            bee.state.approachVoidHexKeys,
          ) ?? landing;
        if (!isQueenLandingHex(defender, desired)) {
          beesChanged = true;
          continue;
        }
        const needRetarget =
          !hexEquals(desired, landing) || !hexEquals(desired, f.to.hex);
        const nextState = needRetarget
          ? {
              ...bee.state,
              landingHex: desired,
              flight: {
                ...f,
                to: { panel: bee.state.assaultPanel, hex: desired },
              },
            }
          : bee.state;
        if (needRetarget) beesChanged = true;
        remainingBees.push({ ...bee, state: nextState });
        continue;
      }
      remainingBees.push(bee);
      continue;
    }

    if (bee.state.kind === 'worker-flying-to-flower') {
      const target = bee.state.target;
      const freedHere = (updatedPlayer.freedLetters ?? []).find((f) =>
        hexEquals(f.hex, target),
      );
      if (freedHere) {
        updatedPlayer = {
          ...updatedPlayer,
          freedLetters: (updatedPlayer.freedLetters ?? []).filter((f) => f.id !== freedHere.id),
        };
        const drop = pickEmptyStorage(updatedPlayer);
        if (!drop) {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `storage full, ${freedHere.letter} lost`,
          });
          remainingBees.push({
            ...bee,
            state: {
              kind: 'worker-returning',
              flight: flight(
                hivePanel,
                target,
                hivePanel,
                hex(0, 0),
                next.t,
                FLIGHT_TIMES.tileToHive,
              ),
            },
          });
        } else {
          remainingBees.push({
            ...bee,
            state: {
              kind: 'worker-flying-to-door-carrying',
              queue: bee.state.queue,
              carrying: freedHere.letter,
              dropTile: drop.hex,
              flight: flight(
                hivePanel,
                target,
                hivePanel,
                hex(0, 0),
                next.t,
                FLIGHT_TIMES.tileToHive,
              ),
            },
          });
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${freedHere.letter} recovered`,
          });
        }
        beesChanged = true;
        continue;
      }
      const found = petalAt(updatedPatches, target);
      if (found) {
        // Got there first — collect the petal's letter.
        updatedPatches = removePetal(updatedPatches, found.patch.id, target);
        const drop = pickEmptyStorage(updatedPlayer);
        if (!drop) {
          // Storage is full — letter is wasted; head home.
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `storage full, ${found.petal.letter} lost`,
          });
          remainingBees.push({
            ...bee,
            state: {
              kind: 'worker-returning',
              flight: flight(
                'flowers',
                target,
                hivePanel,
                hex(0, 0),
                next.t,
                FLIGHT_TIMES.flowerToHive,
              ),
            },
          });
        } else {
          remainingBees.push({
            ...bee,
            state: {
              kind: 'worker-flying-to-door-carrying',
              queue: bee.state.queue,
              carrying: found.petal.letter,
              dropTile: drop.hex,
              flight: flight(
                'flowers',
                target,
                hivePanel,
                hex(0, 0),
                next.t,
                FLIGHT_TIMES.flowerToHive,
              ),
            },
          });
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${found.petal.letter} grabbed`,
          });
        }
        beesChanged = true;
        continue;
      }
      // Petal was withered, collected, or its patch despawned — skip it.
      next = logEvent(next, {
        t: next.t,
        ownerId: player.id,
        text: `petal at ${target.q},${target.r} missed`,
      });
      const [nextTarget, ...rest] = bee.state.queue;
      if (!nextTarget) {
        remainingBees.push({
          ...bee,
          state: {
            kind: 'worker-returning',
            flight: flight(
              'flowers',
              target,
              hivePanel,
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.flowerToHive,
            ),
          },
        });
      } else {
        remainingBees.push({
          ...bee,
          state: {
            kind: 'worker-flying-to-flower',
            queue: rest,
            target: nextTarget,
            flight: flight(
              'flowers',
              target,
              'flowers',
              nextTarget,
              next.t,
              FLIGHT_TIMES.flowerToFlower,
            ),
          },
        });
      }
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'worker-flying-to-door-carrying') {
      const dropTile = bee.state.dropTile;
      const letter = bee.state.carrying;
      // Letter lands when the bee reaches the hive door — no separate hop to a storage hex.
      const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, dropTile));
      if (tile && tile.state === 'storage' && !tile.letter) {
        updatedPlayer = {
          ...updatedPlayer,
          tiles: updatedPlayer.tiles.map((t) =>
            hexEquals(t.hex, dropTile) ? { ...t, letter } : t,
          ),
        };
        next = logEvent(next, {
          t: next.t,
          ownerId: player.id,
          text: `${letter} stored`,
        });
      } else {
        const fallback = pickEmptyStorage(updatedPlayer);
        if (fallback) {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: updatedPlayer.tiles.map((t) =>
              hexEquals(t.hex, fallback.hex) ? { ...t, letter } : t,
            ),
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letter} stored`,
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letter} lost`,
          });
        }
      }
      const newCapacity = bee.capacity - 1;
      const [nextTarget, ...rest] = bee.state.queue;
      if (newCapacity > 0 && nextTarget) {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: 'worker-flying-to-flower',
            queue: rest,
            target: nextTarget,
            flight: flight(
              hivePanel,
              hex(0, 0),
              'flowers',
              nextTarget,
              next.t,
              FLIGHT_TIMES.hiveToFlower,
            ),
          },
        });
      } else {
        // Bee despawns at the door after depositing the letter.
      }
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'worker-flying-to-freed') {
      const freedTargetHex = bee.state.target;
      const found = (updatedPlayer.freedLetters ?? []).find((f) =>
        hexEquals(f.hex, freedTargetHex),
      );
      if (!found) {
        remainingBees.push({
          ...bee,
          state: {
            kind: 'worker-returning',
            flight: flight(
              hivePanel,
              freedTargetHex,
              hivePanel,
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.tileToHive,
            ),
          },
        });
        beesChanged = true;
        continue;
      }
      updatedPlayer = {
        ...updatedPlayer,
        freedLetters: (updatedPlayer.freedLetters ?? []).filter((f) => f.id !== found.id),
      };
      const drop = pickEmptyStorage(updatedPlayer);
      if (!drop) {
        remainingBees.push({
          ...bee,
          state: {
            kind: 'worker-returning',
            flight: flight(
              hivePanel,
              freedTargetHex,
              hivePanel,
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.tileToHive,
            ),
          },
        });
      } else {
        remainingBees.push({
          ...bee,
          state: {
            kind: 'worker-flying-to-door-carrying',
            queue: [],
            carrying: found.letter,
            dropTile: drop.hex,
            flight: flight(
              hivePanel,
              freedTargetHex,
              hivePanel,
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.tileToHive,
            ),
          },
        });
      }
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'worker-returning') {
      // Despawn — drop the bee from the player's bees array.
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'capping') {
      const paths = bee.state.paths;
      const wordsLetters: Letter[][] = [];
      /** True when this path used at least one hex already `capped` before this cap (branch reuse). */
      const crossesPriorCappedByWord: boolean[] = [];
      const allCappedHexes: Hex[] = [];
      const reuseIncrementsByKey = new Map<string, number>();
      for (const path of paths) {
        const letters: Letter[] = [];
        let valid = true;
        const cappedHitsThisPath: Hex[] = [];
        for (const h of path) {
          const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, h));
          if (!tile || !tileHasDraftableLetter(tile)) {
            valid = false;
            break;
          }
          letters.push(tile.letter);
          if (tile.state === 'capped') cappedHitsThisPath.push(h);
        }
        if (valid && letters.length >= 2) {
          wordsLetters.push(letters);
          crossesPriorCappedByWord.push(cappedHitsThisPath.length > 0);
          for (const h of path) {
            if (!allCappedHexes.some((c) => hexEquals(c, h))) allCappedHexes.push(h);
          }
          for (const h of cappedHitsThisPath) {
            const k = hexKey(h);
            reuseIncrementsByKey.set(k, (reuseIncrementsByKey.get(k) ?? 0) + 1);
          }
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `${letters.join('') || 'word'} missed`,
          });
        }
      }
      if (wordsLetters.length > 0) {
        const newlyCappedHexes: Hex[] = [];
        for (const h of allCappedHexes) {
          const t0 = updatedPlayer.tiles.find((t) => hexEquals(t.hex, h));
          if (t0 && t0.state !== 'capped') newlyCappedHexes.push(h);
        }
        const bonus = wordsLetters.reduce(
          (s, letters, i) =>
            s + honeyForCappedWord(letters, crossesPriorCappedByWord[i] ?? false),
          0,
        );
        updatedPlayer = {
          ...updatedPlayer,
          tiles: updatedPlayer.tiles.map((t) => {
            const k = hexKey(t.hex);
            const shouldCap = allCappedHexes.some((h) => hexEquals(h, t.hex));
            const reuseInc = reuseIncrementsByKey.get(k) ?? 0;
            if (!shouldCap && reuseInc === 0) return t;
            return {
              ...t,
              state: shouldCap ? 'capped' : t.state,
              reuseCount: (t.reuseCount ?? 0) + reuseInc,
            };
          }),
        };
        updatedPlayer = grantHoney(updatedPlayer, bonus);
        for (let wi = 0; wi < wordsLetters.length; wi++) {
          updatedPlayer = recordBestWord(
            updatedPlayer,
            wordsLetters[wi]!,
            crossesPriorCappedByWord[wi] ?? false,
          );
        }
        const summary = wordsLetters.map((w) => w.join('')).join(' + ');
        const beeBloom = wordsLetters.some((letters) =>
          isBeeRelatedWord(letters.join('')),
        );
        const reuseTag = crossesPriorCappedByWord.some(Boolean) ? ' reuse!' : '';
        const beeTag = beeBloom ? ' pollen bloom!' : '';
        next = logEvent(next, {
          t: next.t,
          ownerId: player.id,
          text: `${summary} +${bonus} 🜨${reuseTag}${beeTag}`,
        });
        if (beeBloom && rng) {
          const bloomPatches = spawnPollenBloomPatches(
            updatedPatches,
            rng,
            next.t,
            next.playerCount,
          );
          if (bloomPatches.length > 0) {
            updatedPatches = [...updatedPatches, ...bloomPatches];
          }
        }
        // Auto-expand the frontier: one free carpenter chains adjacent hexes.
        // Bee-related words expand every eligible neighbor; otherwise up to (n − 2).
        const wordLength = wordsLetters[0]?.length ?? 0;
        const expansionBudget = beeBloom
          ? Number.POSITIVE_INFINITY
          : Math.max(0, wordLength - 2);
        const ownedAfter = new Set(updatedPlayer.tiles.map((t) => hexKey(t.hex)));
        const expansionTargets = new Map<string, Hex>();
        for (const h of allCappedHexes) {
          for (const n of neighbors(h)) {
            const nk = hexKey(n);
            if (ownedAfter.has(nk)) continue;
            expansionTargets.set(nk, n);
          }
        }
        const sortedExpansion = [...expansionTargets.values()].sort((a, b) =>
          hexKey(a).localeCompare(hexKey(b)),
        );
        const expansionChain: Hex[] = [];
        for (const target of sortedExpansion) {
          if (
            Number.isFinite(expansionBudget) &&
            expansionChain.length >= expansionBudget
          ) {
            break;
          }
          const tk = hexKey(target);
          if (reservedCarpenterTargets.has(tk)) continue;
          if (!isCarpenterEligible(updatedPlayer, target)) continue;
          reservedCarpenterTargets.add(tk);
          expansionChain.push(target);
        }
        if (expansionChain.length > 0) {
          const first = expansionChain[0]!;
          const rest = expansionChain.slice(1);
          remainingBees.push({
            id: newId(),
            kind: 'carpenter',
            ownerId: player.id,
            capacity: expansionChain.length,
            state: {
              kind: 'carpenter-flying',
              queue: rest,
              target: first,
              flight: flight(
                hivePanel,
                hex(0, 0),
                hivePanel,
                first,
                next.t,
                FLIGHT_TIMES.hiveToTile,
              ),
            },
          });
        }
      }
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'carpenter-flying') {
      const target = bee.state.target;
      const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, target));
      if (tile) {
        // Pre-existing tile (legacy `inactive` from the old layout): flip it.
        if (tile.state === 'inactive') {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: updatedPlayer.tiles.map((t) =>
              hexEquals(t.hex, target) ? { ...t, state: 'active' } : t,
            ),
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile activated`,
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile already active`,
          });
        }
      } else {
        // Frontier expansion: append a new active tile if the target is still
        // adjacent to the hive (it could have grown since the bee launched).
        const stillFrontier = neighbors(target).some((n) =>
          updatedPlayer.tiles.some(
            (t) =>
              hexEquals(t.hex, n) &&
              (t.state === 'active' || t.state === 'letter' || t.state === 'capped'),
          ),
        );
        if (stillFrontier) {
          updatedPlayer = {
            ...updatedPlayer,
            tiles: [
              ...updatedPlayer.tiles,
              { hex: target, state: 'active' as const, letter: null, reuseCount: 0, damage: 0 },
            ],
          };
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile activated`,
          });
        } else {
          next = logEvent(next, {
            t: next.t,
            ownerId: player.id,
            text: `tile no longer reachable`,
          });
        }
      }
      const newCapacity = bee.capacity - 1;
      const [nextTarget, ...rest] = bee.state.queue;
      if (newCapacity > 0 && nextTarget) {
        reservedCarpenterTargets.add(hexKey(nextTarget));
        for (const qh of rest) reservedCarpenterTargets.add(hexKey(qh));
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: 'carpenter-flying',
            queue: rest,
            target: nextTarget,
            flight: flight(
              hivePanel,
              target,
              hivePanel,
              nextTarget,
              next.t,
              FLIGHT_TIMES.tileToTile,
            ),
          },
        });
      } else {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: 'carpenter-returning',
            flight: flight(
              hivePanel,
              target,
              hivePanel,
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.tileToHive,
            ),
          },
        });
      }
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'carpenter-returning') {
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'queen-flying') {
      if (!Number.isFinite(bee.state.expiresAt) || world.t >= bee.state.expiresAt) {
        beesChanged = true;
        continue;
      }
      // Arrived at the opponent grid — switch to autonomous assault. The first
      // attack lands a short beat after touchdown so the player can register
      // the hand-off visually.
      remainingBees.push({
        ...bee,
        state: {
          kind: 'queen-assault',
          panel: bee.state.assaultPanel,
          defenderPlayerId: bee.state.defenderPlayerId,
          currentHex: bee.state.landingHex,
          expiresAt: next.t + QUEEN_ASSAULT_DURATION_SECONDS,
          nextActionAt: next.t + 0.45,
        },
      });
      next = logEvent(next, {
        t: next.t,
        ownerId: player.id,
        text: `queen lands`,
      });
      beesChanged = true;
      continue;
    }

    if (bee.state.kind === 'queen-assault') {
      remainingBees.push(bee);
      continue;
    }
  }

  if (beesChanged) {
    updatedPlayer = { ...updatedPlayer, bees: remainingBees };
  }
  next = setPlayerById(next, playerId, updatedPlayer);
  if (updatedPatches !== world.patches) {
    next = { ...next, patches: updatedPatches };
  }
  return next;
};

/**
 * Pick a neighbour of `from` that starts a shortest walk to the hive in axial steps.
 *
 * Nodes are hive centre, every defender-owned hex, and any **void** coord (tile
 * already destroyed). Edges join 6-neighbours; capped so runaway axial void
 * cannot drain BFS indefinitely.
 *
 * Steps along that shortest path minimise travel through defender territory /
 * corridors the queen clears.
 */
const shortestQueenHopTowardHive = (defender: PlayerState, from: Hex): Hex | null => {
  const goal = hex(0, 0);
  const tileByHex = new Map(defender.tiles.map((t) => [hexKey(t.hex), t]));
  const goalKey = hexKey(goal);
  if (!tileByHex.has(goalKey)) return null;

  const maxHullRadius = defender.tiles.reduce((m, t) => Math.max(m, cubeDistance(t.hex, goal)), 0);
  /** Allowed void exploration past the farthest hive ring (narrow carved tunnels). */
  const maxVoidReach = Math.max(maxHullRadius + 32, 32);
  /** Hard cap unrelated to hive distance so pathological void chains cannot churn. */
  const visitBudget = Math.min(60_000, defender.tiles.length * 96 + 2_048);

  const dist = new Map<string, number>();
  dist.set(goalKey, 0);
  const q: Hex[] = [goal];
  let visits = 0;

  while (q.length > 0 && visits < visitBudget) {
    visits++;
    const cur = q.shift()!;
    const dc = dist.get(hexKey(cur))!;
      const nextDc = dc + 1;

    for (const nbr of neighbors(cur)) {
      const nk = hexKey(nbr);
      if (dist.has(nk)) continue;
      if (cubeDistance(nbr, goal) > maxVoidReach) continue;

      dist.set(nk, nextDc);
      q.push(nbr);
    }
  }

  if (!dist.has(hexKey(from))) return null;

  let best: Hex | null = null;
  let bestD = Infinity;
  for (const nbr of neighbors(from)) {
    const nk = hexKey(nbr);
    const d = dist.get(nk);
    if (d === undefined) continue;
    if (best === null || d < bestD || (d === bestD && nk.localeCompare(hexKey(best)) < 0)) {
      bestD = d;
      best = nbr;
    }
  }

  return best;
};

const HIVE_CENTER = hex(0, 0);

const defenderHasHiveTile = (player: PlayerState): boolean =>
  player.tiles.some((t) => t.state === 'hive' && hexEquals(t.hex, HIVE_CENTER));

const defenderHasAllStorage = (player: PlayerState): boolean =>
  player.tiles.filter((t) => t.state === 'storage').length >= STORAGE_SLOT_COUNT;

/** Queen reached the hive center, destroyed the hive tile, or smashed a storage slot. */
const queenBreachedDefender = (defender: PlayerState, queenHex: Hex): boolean =>
  hexEquals(queenHex, HIVE_CENTER) ||
  !defenderHasHiveTile(defender) ||
  !defenderHasAllStorage(defender);

type DestroyTileResult = { readonly player: PlayerState; readonly hiveDestroyed: boolean };

const destroyTile = (player: PlayerState, h: Hex, t: number): DestroyTileResult => {
  const tile = player.tiles.find((x) => hexEquals(x.hex, h));
  if (!tile) return { player, hiveDestroyed: false };
  const hiveDestroyed = tile.state === 'hive';
  const nextTiles = player.tiles.filter((x) => !hexEquals(x.hex, h));
  const freed =
    !hiveDestroyed && tile.letter !== null
      ? [
          ...(player.freedLetters ?? []),
          {
            id: newId(),
            hex: h,
            letter: tile.letter,
            spawnedAt: t,
            witherAt: t + FREED_LETTER_LIFETIME_SECONDS,
          },
        ]
      : (player.freedLetters ?? []);
  return {
    player: { ...player, tiles: nextTiles, freedLetters: freed },
    hiveDestroyed,
  };
};

const eliminatePlayer = (
  world: World,
  attackerId: string,
  attacker: PlayerState,
  defenderId: string,
  defender: PlayerState,
  bees: readonly Bee[],
): World => {
  let next = setPlayerById(world, defenderId, { ...defender, bees: [] });
  next = setPlayerById(next, attackerId, { ...attacker, bees: [...bees] });
  const activePlayerIds = next.activePlayerIds.filter((id) => id !== defenderId);
  const eliminatedPlayerIds = [...next.eliminatedPlayerIds, defenderId];
  next = logEvent(next, {
    t: next.t,
    ownerId: attackerId,
    text: `${defenderId} eliminated!`,
  });
  if (activePlayerIds.length === 1) {
    return {
      ...next,
      activePlayerIds,
      eliminatedPlayerIds,
      phase: 'over',
      winnerId: activePlayerIds[0] ?? null,
    };
  }
  return { ...next, activePlayerIds, eliminatedPlayerIds };
};

/** Remove a player who disconnected or forfeited. */
export const eliminateByForfeit = (world: World, playerId: string): World => {
  if (!world.activePlayerIds.includes(playerId)) return world;
  const player = getPlayer(world, playerId);
  let next = setPlayerById(world, playerId, { ...player, bees: [] });
  const activePlayerIds = next.activePlayerIds.filter((id) => id !== playerId);
  const eliminatedPlayerIds = [...next.eliminatedPlayerIds, playerId];
  next = logEvent(next, {
    t: next.t,
    ownerId: playerId,
    text: 'forfeit',
  });
  if (activePlayerIds.length === 1) {
    return {
      ...next,
      activePlayerIds,
      eliminatedPlayerIds,
      phase: 'over',
      winnerId: activePlayerIds[0] ?? null,
    };
  }
  if (activePlayerIds.length === 0) {
    return {
      ...next,
      activePlayerIds,
      eliminatedPlayerIds,
      phase: 'over',
      winnerId: null,
    };
  }
  return { ...next, activePlayerIds, eliminatedPlayerIds };
};

const tickQueens = (world: World): World => {
  let next = world;
  for (const attackerId of world.activePlayerIds) {
    const attacker = getPlayer(next, attackerId);
    const bees: Bee[] = [];
    let dirty = false;
    for (const bee of attacker.bees) {
      if (bee.state.kind !== 'queen-assault') {
        bees.push(bee);
        continue;
      }
      dirty = true;
      const defenderId = bee.state.defenderPlayerId;
      if (!next.activePlayerIds.includes(defenderId)) {
        continue;
      }
      let defender = getPlayer(next, defenderId);
      if (!Number.isFinite(bee.state.expiresAt) || next.t >= bee.state.expiresAt) continue;
      if (next.t < bee.state.nextActionAt) {
        bees.push(bee);
        continue;
      }
      const ch = bee.state.currentHex;
      if (queenBreachedDefender(defender, ch)) {
        return eliminatePlayer(next, attackerId, attacker, defenderId, defender, bees);
      }
      const tileHere = defender.tiles.find((t) => hexEquals(t.hex, ch));
      if (tileHere) {
        const nextDamage = (tileHere.damage ?? 0) + QUEEN_DAMAGE_PER_STRIKE;
        if (nextDamage >= hexHpForTile(tileHere)) {
          const destroyed = destroyTile(defender, ch, next.t);
          defender = destroyed.player;
          if (destroyed.hiveDestroyed || queenBreachedDefender(defender, ch)) {
            return eliminatePlayer(next, attackerId, attacker, defenderId, defender, bees);
          }
          next = logEvent(next, {
            t: next.t,
            ownerId: attacker.id,
            text: `queen smashed ${tileHere.letter ?? 'tile'}`,
          });
        } else {
          defender = {
            ...defender,
            tiles: defender.tiles.map((t) =>
              hexEquals(t.hex, ch) ? { ...t, damage: nextDamage } : t,
            ),
          };
        }
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS },
        });
        next = setPlayerById(next, defenderId, defender);
        continue;
      }

      const step = shortestQueenHopTowardHive(defender, ch);
      if (!step) {
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS },
        });
        continue;
      }
      if (queenBreachedDefender(defender, step)) {
        return eliminatePlayer(next, attackerId, attacker, defenderId, defender, bees);
      }
      const targetTile = defender.tiles.find((t) => hexEquals(t.hex, step));
      if (!targetTile) {
        bees.push({
          ...bee,
          state: {
            ...bee.state,
            currentHex: step,
            nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS,
          },
        });
        continue;
      }
      const nextDamage = (targetTile.damage ?? 0) + QUEEN_DAMAGE_PER_STRIKE;
      if (nextDamage >= hexHpForTile(targetTile)) {
        const destroyed = destroyTile(defender, step, next.t);
        defender = destroyed.player;
        if (destroyed.hiveDestroyed || queenBreachedDefender(defender, step)) {
          return eliminatePlayer(next, attackerId, attacker, defenderId, defender, bees);
        }
        next = logEvent(next, {
          t: next.t,
          ownerId: attacker.id,
          text: `queen smashed ${targetTile.letter ?? 'tile'}`,
        });
        bees.push({
          ...bee,
          state: {
            ...bee.state,
            currentHex: step,
            nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS,
          },
        });
      } else {
        defender = {
          ...defender,
          tiles: defender.tiles.map((t) =>
            hexEquals(t.hex, step) ? { ...t, damage: nextDamage } : t,
          ),
        };
        bees.push({
          ...bee,
          state: { ...bee.state, nextActionAt: next.t + QUEEN_ACTION_INTERVAL_SECONDS },
        });
      }
      next = setPlayerById(next, defenderId, defender);
    }
    if (dirty) {
      next = setPlayerById(next, attackerId, { ...attacker, bees });
    }
  }
  return next;
};

const arrivalOf = (bee: Bee): number | null => {
  switch (bee.state.kind) {
    case 'worker-flying-to-flower':
    case 'worker-flying-to-door-carrying':
    case 'worker-flying-to-freed':
    case 'worker-returning':
    case 'carpenter-flying':
    case 'carpenter-returning':
    case 'queen-flying':
      return bee.state.flight.arrivesAt;
    case 'capping':
      return bee.state.arrivesAt;
    default:
      return null;
  }
};

// ---- Player commands -------------------------------------------------------

export type CommandResult =
  | { ok: true; world: World }
  | { ok: false; world: World; reason: string };

/**
 * Hold-to-send: spawn a single-trip worker bee that leaves the hive door,
 * flies to one petal (or a freed letter on the hive), and returns to the door
 * with the letter — storage is filled when the bee reaches the door (no
 * separate hop to a storage hex). Every dispatch costs `worker.honeyCost`.
 */
const resolveActorId = (world: World, actor: Side | string): string =>
  actor === 'self' || actor === 'opponent'
    ? playerIdForSide(world, actor)
    : actor;

export const dispatchWorker = (
  world: World,
  playerId: string,
  target: Hex,
): CommandResult => {
  const player = getPlayer(world, playerId);
  const cost = BEE_STATS.worker.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  const freedTarget = (player.freedLetters ?? []).find((f) => hexEquals(f.hex, target));
  const flowerTarget = freedTarget ? null : petalAt(world.patches, target);
  if (!flowerTarget && !freedTarget) return { ok: false, world, reason: 'no letter here' };
  const emptyStorage = player.tiles.some((t) => t.state === 'storage' && !t.letter);
  if (!emptyStorage) {
    return { ok: false, world, reason: 'storage is full' };
  }

  const panel = hivePanelForPlayer(world, playerId);
  const bee: Bee = {
    id: newId(),
    kind: 'worker',
    ownerId: player.id,
    capacity: BEE_STATS.worker.capacity,
    state: freedTarget
      ? {
          kind: 'worker-flying-to-freed',
          target,
          flight: flight(panel, hex(0, 0), panel, target, world.t, FLIGHT_TIMES.hiveToTile),
        }
      : {
          kind: 'worker-flying-to-flower',
          queue: [],
          target,
          flight: flight(panel, hex(0, 0), 'flowers', target, world.t, FLIGHT_TIMES.hiveToFlower),
        },
  };

  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
  };
  return { ok: true, world: setPlayerById(world, playerId, updated) };
};

export const dispatchQueen = (
  world: World,
  playerId: string,
  opts?: {
    readonly target?: Hex;
    readonly attackSide?: QueenAttackSide;
    readonly targetPlayerId?: string;
  },
): CommandResult => {
  const player = getPlayer(world, playerId);
  const cost = BEE_STATS.queen.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (player.tiles.length < QUEEN_MIN_OWNED_HEXES) {
    return { ok: false, world, reason: 'queen min hive size' };
  }
  if (activeQueenCountFor(player) >= queenAllowanceFor(player)) {
    return { ok: false, world, reason: 'queen allowance reached' };
  }
  const activeOpponents = world.activePlayerIds.filter((id) => id !== playerId);
  let defenderId = opts?.targetPlayerId;
  if (activeOpponents.length > 1) {
    if (!defenderId || !activeOpponents.includes(defenderId)) {
      return { ok: false, world, reason: 'choose a target player' };
    }
  } else {
    defenderId = defenderId ?? activeOpponents[0];
  }
  if (!defenderId) return { ok: false, world, reason: 'no target player' };
  if (world.eliminatedPlayerIds.includes(defenderId)) {
    return { ok: false, world, reason: 'target eliminated' };
  }
  const enemy = getPlayer(world, defenderId);
  const { target, attackSide } = opts ?? {};
  if (target !== undefined && attackSide !== undefined) {
    return { ok: false, world, reason: 'queen attack overspecified' };
  }
  let landing: Hex | null;
  if (attackSide !== undefined) {
    landing = pickQueenLandingHexForSide(enemy, attackSide);
    if (!landing || !isQueenSpawnTargetHex(enemy, landing)) {
      return { ok: false, world, reason: 'invalid queen attack side' };
    }
  } else if (target !== undefined) {
    if (!isQueenSpawnTargetHex(enemy, target)) {
      return { ok: false, world, reason: 'invalid queen target' };
    }
    landing = target;
  } else {
    landing = pickQueenLandingHex(enemy);
  }
  if (!landing) return { ok: false, world, reason: 'enemy hive unavailable' };
  const ownerPanel = hivePanelForPlayer(world, playerId);
  const enemyPanel = hivePanelForPlayer(world, defenderId);
  const bee: Bee = {
    id: newId(),
    kind: 'queen',
    ownerId: player.id,
    capacity: 1,
    state: {
      kind: 'queen-flying',
      assaultPanel: enemyPanel,
      defenderPlayerId: defenderId,
      landingHex: landing,
      approachVoidHexKeys: queenApproachVoidHexKeys(enemy, landing),
      ...(attackSide !== undefined ? { attackSide } : {}),
      expiresAt: world.t + FLIGHT_TIMES.queenToHive + QUEEN_ASSAULT_DURATION_SECONDS,
      flight: flight(
        ownerPanel,
        hex(0, 0),
        enemyPanel,
        landing,
        world.t,
        FLIGHT_TIMES.queenToHive,
      ),
    },
  };
  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
  };
  return { ok: true, world: setPlayerById(world, playerId, updated) };
};

export const placeLetter = (
  world: World,
  playerId: string,
  fromHex: Hex,
  toHex: Hex,
): CommandResult => {
  if (hexEquals(fromHex, toHex)) {
    return { ok: false, world, reason: 'source and destination are the same' };
  }
  const player = getPlayer(world, playerId);
  const source = player.tiles.find((t) => hexEquals(t.hex, fromHex));
  const dest = player.tiles.find((t) => hexEquals(t.hex, toHex));
  if (!source?.letter) {
    return { ok: false, world, reason: 'no letter at source' };
  }
  if (source.state === 'capped') {
    return { ok: false, world, reason: 'capped letters cannot be moved' };
  }
  const fromStorage = source.state === 'storage';
  const fromGrid =
    (source.state === 'active' && source.letter) ||
    (source.state === 'letter' && source.letter);
  if (!fromStorage && !fromGrid) {
    return { ok: false, world, reason: 'invalid source for letter move' };
  }
  if (!dest || dest.letter) {
    return { ok: false, world, reason: 'destination already holds a letter' };
  }
  if (dest.state !== 'active' && dest.state !== 'storage') {
    return { ok: false, world, reason: 'destination is not a letter slot' };
  }
  const letter = source.letter;
  const updated: PlayerState = {
    ...player,
    tiles: player.tiles.map((t) => {
      if (hexEquals(t.hex, fromHex)) {
        if (fromStorage) return { ...t, letter: null };
        return { ...t, state: 'active' as const, letter: null };
      }
      if (hexEquals(t.hex, toHex)) {
        return dest.state === 'storage'
          ? { ...t, letter }
          : { ...t, state: 'active' as const, letter };
      }
      return t;
    }),
  };
  return { ok: true, world: setPlayerById(world, playerId, updated) };
};

/**
 * Submit a single drafted word path for capping. The path must be at least 2
 * tiles, contiguous, and pass only over uncapped honeycomb letters, `letter`
 * legacy tiles, or `capped` branch tiles. A prior word+hex-letter combination
 * cannot be submitted again.
 */
export const trySubmitWord = (
  world: World,
  playerId: string,
  paths: readonly (readonly Hex[])[],
): CommandResult => {
  const player = getPlayer(world, playerId);
  const cost = BEE_STATS.drone.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (paths.length === 0) return { ok: false, world, reason: 'no words submitted' };
  if (paths.length !== 1) {
    return { ok: false, world, reason: 'one word per drone' };
  }
  const seenSignatures = new Set(player.usedWordSignatures);
  const nextSignatures: string[] = [];
  for (const path of paths) {
    if (path.length < 2) return { ok: false, world, reason: 'word too short' };
    if (!isValidPath(path)) return { ok: false, world, reason: 'path is not contiguous' };
    const letters: Letter[] = [];
    const placements: string[] = [];
    for (const h of path) {
      const tile = player.tiles.find((t) => hexEquals(t.hex, h));
      if (!tile || !tileHasDraftableLetter(tile)) {
        return { ok: false, world, reason: 'path includes a non-letter tile' };
      }
      letters.push(tile.letter);
      placements.push(`${h.q},${h.r}:${tile.letter}`);
    }
    const word = letters.join('');
    // Signature is independent of drag direction: same word + same lettered
    // hex assignments cannot be scored repeatedly.
    const signature = `${word}|${placements.sort().join('|')}`;
    if (seenSignatures.has(signature)) {
      return { ok: false, world, reason: 'word already used on these tiles' };
    }
    seenSignatures.add(signature);
    nextSignatures.push(signature);
  }
  const flightSeconds = FLIGHT_TIMES.cappingPerPath;
  const bee: Bee = {
    id: newId(),
    kind: 'drone',
    ownerId: player.id,
    capacity: BEE_STATS.drone.capacity,
    state: {
      kind: 'capping',
      panel: hivePanelForPlayer(world, playerId),
      paths,
      startedAt: world.t,
      arrivesAt: world.t + flightSeconds,
    },
  };
  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
    usedWordSignatures: [...player.usedWordSignatures, ...nextSignatures],
  };
  return { ok: true, world: setPlayerById(world, playerId, updated) };
};

const isCarpenterEligible = (player: PlayerState, h: Hex): boolean => {
  const tile = player.tiles.find((t) => hexEquals(t.hex, h));
  // Already-owned tile: only legacy `inactive` is buildable. Other states are
  // either already active or non-buildable infrastructure (hive/storage).
  if (tile) return tile.state === 'inactive';
  // Frontier hex: must touch one of the player's active/letter/capped tiles.
  return neighbors(h).some((n) => {
    const nb = player.tiles.find((t) => hexEquals(t.hex, n));
    if (!nb) return false;
    return nb.state === 'active' || nb.state === 'letter' || nb.state === 'capped';
  });
};

/**
 * Hold-to-send: spawn a single-trip carpenter bee that flies to one frontier
 * (or legacy `inactive`) hex and activates it. Every dispatch costs
 * `carpenter.honeyCost` (post-cap auto expansion uses a separate code path with
 * a multi-hex queue and no honey charge).
 */
export const dispatchCarpenter = (
  world: World,
  playerId: string,
  target: Hex,
): CommandResult => {
  const player = getPlayer(world, playerId);
  const cost = BEE_STATS.carpenter.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (!isCarpenterEligible(player, target)) {
    return { ok: false, world, reason: 'tile must touch your hive' };
  }

  const panel = hivePanelForPlayer(world, playerId);
  const bee: Bee = {
    id: newId(),
    kind: 'carpenter',
    ownerId: player.id,
    capacity: BEE_STATS.carpenter.capacity,
    state: {
      kind: 'carpenter-flying',
      queue: [],
      target,
      flight: flight(
        panel,
        hex(0, 0),
        panel,
        target,
        world.t,
        FLIGHT_TIMES.hiveToTile,
      ),
    },
  };

  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
  };
  return { ok: true, world: setPlayerById(world, playerId, updated) };
};

// ---- Unified command + snapshot surface -----------------------------------

/**
 * Apply a typed {@link GameCommand} to the world for the given side. This is
 * the single entry point both the authoritative server and the local client
 * use to mutate the world from a player action — keep new dispatch verbs
 * routed through here so the wire protocol and engine stay in lockstep.
 */
export const applyCommand = (
  world: World,
  actor: Side | string,
  cmd: GameCommand,
): CommandResult => {
  const playerId = resolveActorId(world, actor);
  switch (cmd.kind) {
    case 'dispatchWorker':
      return dispatchWorker(world, playerId, cmd.target);
    case 'dispatchCarpenter':
      return dispatchCarpenter(world, playerId, cmd.target);
    case 'dispatchQueen':
      return dispatchQueen(world, playerId, {
        ...(cmd.target !== undefined ? { target: cmd.target } : {}),
        ...(cmd.attackSide !== undefined ? { attackSide: cmd.attackSide } : {}),
        ...(cmd.targetPlayerId !== undefined ? { targetPlayerId: cmd.targetPlayerId } : {}),
      });
    case 'placeLetter':
      return placeLetter(world, playerId, cmd.from, cmd.to);
    case 'submitWords':
      return trySubmitWord(world, playerId, cmd.paths);
  }
};

const remapFlightForViewer = (
  world: World,
  viewerId: string,
  flight: BeeFlight,
): BeeFlight => ({
  ...flight,
  from: { ...flight.from, panel: remapBeePanelForViewer(world, viewerId, flight.from.panel) },
  to: { ...flight.to, panel: remapBeePanelForViewer(world, viewerId, flight.to.panel) },
});

const remapBeeForViewer = (world: World, viewerId: string, bee: Bee): Bee => {
  const s = bee.state;
  let next: BeeState;
  switch (s.kind) {
    case 'worker-flying-to-flower':
    case 'worker-flying-to-door-carrying':
    case 'worker-flying-to-freed':
    case 'worker-returning':
    case 'carpenter-flying':
    case 'carpenter-returning':
      next = { ...s, flight: remapFlightForViewer(world, viewerId, s.flight) };
      break;
    case 'queen-flying':
      next = {
        ...s,
        flight: remapFlightForViewer(world, viewerId, s.flight),
        assaultPanel: remapBeePanelForViewer(
          world,
          viewerId,
          s.assaultPanel,
        ) as HiveAssaultPanel,
      };
      break;
    case 'capping':
    case 'queen-assault':
      next = {
        ...s,
        panel: remapBeePanelForViewer(world, viewerId, s.panel) as HiveAssaultPanel,
      };
      break;
  }
  return { ...bee, state: next };
};

const remapPlayerBeesForViewer = (
  world: World,
  viewerId: string,
  player: PlayerState,
): PlayerState => ({
  ...player,
  bees: player.bees.map((b) => remapBeeForViewer(world, viewerId, b)),
});

/**
 * Project a server-side {@link World} into the {@link WorldSnapshot} a single
 * client receives. The viewer always sees themselves as `self`.
 */
export const worldToSnapshot = (
  world: World,
  viewerIdOrSide: string | Side,
  tick: number,
): WorldSnapshot => {
  const viewerId = resolveActorId(world, viewerIdOrSide);
  const opponents = getRivalsOf(world, viewerId);
  const winner =
    world.winnerId === null ? null : world.winnerId === viewerId ? 'self' : null;
  return {
    t: world.t,
    tick,
    phase: world.phase,
    winner,
    self: remapPlayerBeesForViewer(world, viewerId, getPlayer(world, viewerId)),
    opponents: opponents.map((o) =>
      remapPlayerBeesForViewer(world, viewerId, o.player),
    ),
    opponentSlots: opponents.map((o) => o.slot),
    playerCount: world.playerCount,
    eliminatedPlayerIds: world.eliminatedPlayerIds,
    patches: world.patches,
    log: world.log,
  };
};

// ---- Solo dummy AI ---------------------------------------------------------

/**
 * Apply a single tick of the dummy single-player AI. *Not* called by
 * {@link tickWorld} — solo callers either use {@link tickSolo} or compose
 * `tickSoloAi(tickWorld(world, dt, rng), dt, rng)` themselves. The server
 * never invokes this in PvP.
 */
export const tickSoloAi = (world: World, dt: number, rng: () => number): World => {
  if (world.phase === 'over') return world;
  let next = world;
  let {
    aiWorkerCooldown,
    aiPlaceCooldown,
    aiPhantomCooldown,
    aiCarpenterCooldown,
  } = next;
  aiWorkerCooldown -= dt;
  aiPlaceCooldown -= dt;
  aiPhantomCooldown -= dt;
  aiCarpenterCooldown -= dt;

  const aiId = world.playerIds[1] ?? 'opponent';

  if (aiWorkerCooldown <= 0) {
    const ai = getPlayer(next, aiId);
    const hasStorageRoom = ai.tiles.some((t) => t.state === 'storage' && !t.letter);
    if (hasStorageRoom && ai.honey >= BEE_STATS.worker.honeyCost) {
      const claimed = new Set<string>();
      for (const b of ai.bees) {
        if (b.state.kind === 'worker-flying-to-flower') claimed.add(hexKey(b.state.target));
      }
      const available = next.patches
        .flatMap((p) => p.petals.map((pt) => pt.hex))
        .filter((h) => !claimed.has(hexKey(h)));
      if (available.length > 0) {
        const pick = available[Math.floor(rng() * available.length)]!;
        const r = dispatchWorker(next, aiId, pick);
        if (r.ok) next = r.world;
      }
    }
    aiWorkerCooldown = AI_WORKER_BASE + rng() * 3;
  }

  if (aiPlaceCooldown <= 0) {
    const aiPlayer = getPlayer(next, aiId);
    const filledStorage = aiPlayer.tiles.find(
      (t) => t.state === 'storage' && t.letter !== null,
    );
    const emptyActive = aiPlayer.tiles.find(
      (t) => t.state === 'active' && !t.letter,
    );
    if (filledStorage && emptyActive) {
      const r = placeLetter(next, aiId, filledStorage.hex, emptyActive.hex);
      if (r.ok) next = r.world;
    }
    aiPlaceCooldown = AI_PLACE_BASE + rng() * 2;
  }

  if (aiPhantomCooldown <= 0) {
    next = simulatePhantomWord(next, rng);
    aiPhantomCooldown = AI_PHANTOM_BASE + rng() * 4;
  }

  if (aiCarpenterCooldown <= 0) {
    const ai = getPlayer(next, aiId);
    const pending = ai.bees.some(
      (b) => b.state.kind === 'carpenter-flying' || b.state.kind === 'carpenter-returning',
    );
    if (!pending && ai.honey >= BEE_STATS.carpenter.honeyCost) {
      const ownedInactive = ai.tiles
        .filter((t) => t.state === 'inactive')
        .map((t) => t.hex);
      const candidates = [...ownedInactive, ...frontierFor(ai)].filter((h) =>
        isCarpenterEligible(ai, h),
      );
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(rng() * candidates.length)]!;
        const r = dispatchCarpenter(next, aiId, pick);
        if (r.ok) next = r.world;
      }
    }
    aiCarpenterCooldown = AI_CARPENTER_BASE + rng() * 6;
  }

  return {
    ...next,
    aiWorkerCooldown,
    aiPlaceCooldown,
    aiPhantomCooldown,
    aiCarpenterCooldown,
  };
};

const simulatePhantomWord = (world: World, rng: () => number): World => {
  const aiId = world.playerIds[1] ?? 'opponent';
  const length = 3 + Math.floor(rng() * 3);
  const letters: Letter[] = [];
  const pool = [...FLOWER_LETTER_POOLS.vowel, ...FLOWER_LETTER_POOLS.common];
  for (let i = 0; i < length; i++) {
    letters.push(pool[Math.floor(rng() * pool.length)]!);
  }
  const bonus = wordScore(letters);
  let next = world;
  const ai = getPlayer(next, aiId);
  next = setPlayerById(next, aiId, grantHoney(ai, bonus));
  next = logEvent(next, {
    t: next.t,
    ownerId: aiId,
    text: `${letters.join('')} +${bonus} 🜨`,
  });
  return next;
};
