/**
 * Game-state engine.
 *
 * Hive layout: each player starts with a single `'hive'` tile at axial (0,0),
 * 6 `'storage'` slots at radius 1, and 12 `'active'` tiles at radius 2.
 * Carpenters expand the hive *outward indefinitely* — any hex adjacent to your
 * active/letter/capped tiles is a "frontier" hex that can be queued and
 * activated. The renderer derives the frontier on the fly via
 * {@link frontierFor}; the engine only stores tiles you actually own.
 *
 * Flower field: at any time exactly {@link PATCH_TARGET_COUNT} flower patches
 * bloom in the central field. Each patch is a six-petal arrangement around an
 * unused center hex (so each petal is a single pickable letter). Patches come
 * in three types — vowel / common / rare — and slowly wither: petals fall off
 * one by one until either bees collect them all or the patch is empty, at
 * which point a fresh patch spawns elsewhere.
 *
 * Workers operate on a queue of petal hexes selected by the player. SEND
 * WORKER snapshots the queue and dispatches one bee that visits each in
 * order. If a petal is gone when the bee arrives (collected, withered, or
 * the patch despawned) the bee skips it.
 */

import {
  BEE_STATS,
  FLIGHT_TIMES,
  FLOWER_LETTER_POOLS,
  HIVE,
  chainScore,
  damageFor,
  drawFlowerLetter,
  hex,
  hexEquals,
  hexKey,
  isValidPath,
  neighbors,
  range,
  wordScore,
  type Bee,
  type BeeFlight,
  type BeeWaypoint,
  type FlowerPatch,
  type FlowerType,
  type Hex,
  type Letter,
  type Petal,
  type PlayerState,
  type TileSnapshot,
} from '@hivemind/shared';

export type Side = 'self' | 'opponent';
export type GamePhase = 'playing' | 'over';

export interface ActivityEntry {
  readonly id: string;
  readonly t: number;
  readonly ownerId: string;
  readonly text: string;
}

export interface World {
  readonly t: number;
  readonly phase: GamePhase;
  readonly self: PlayerState;
  readonly opponent: PlayerState;
  readonly patches: readonly FlowerPatch[];
  readonly patchCooldown: number;
  readonly aiQueueCooldown: number;
  readonly aiSendCooldown: number;
  readonly aiPlaceCooldown: number;
  readonly aiPhantomCooldown: number;
  readonly aiCarpenterCooldown: number;
  readonly winner: Side | null;
  readonly log: readonly ActivityEntry[];
}

// ---- Constants -------------------------------------------------------------

/** Initial radius of the player hive (rings 0..2 are seeded). Carpenters grow
 *  the hive outward beyond this without bound. */
export const HIVE_RADIUS = 2;
/** Radius of the central flower field. Larger than before to fit 3 patches
 *  (each is 7 hexes) with enough breathing room. */
export const FIELD_RADIUS = 4;
/** Number of flower patches alive in the field at any time. */
export const PATCH_TARGET_COUNT = 3;
/** How long after a patch despawns before a new one can spawn. */
export const PATCH_RESPAWN_SECONDS = 1.5;
/** Total intended lifetime of a freshly spawned patch (seconds). */
export const PATCH_LIFETIME_SECONDS = 28;
/** Two patch centers must be at least this many hexes apart so their petal
 *  rings don't overlap. */
export const PATCH_MIN_CENTER_DISTANCE = 3;
export const ROUND_DURATION_SECONDS = 5 * 60;
export const QUEUE_CAP = BEE_STATS.worker.capacity;
export const CARPENTER_QUEUE_CAP = BEE_STATS.carpenter.capacity;
const LOG_MAX_ENTRIES = 14;
const PATCH_TYPES: readonly FlowerType[] = ['vowel', 'common', 'rare'];

const AI_QUEUE_BASE = 3;
const AI_SEND_BASE = 8;
const AI_PLACE_BASE = 5;
const AI_PHANTOM_BASE = 14;
const AI_CARPENTER_BASE = 20;

// ---- Construction ----------------------------------------------------------

const ringIndex = (h: Hex): number =>
  Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r));

const cubeDistance = (a: Hex, b: Hex): number => {
  const az = -a.q - a.r;
  const bz = -b.q - b.r;
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(az - bz)) / 2;
};

const buildPlayer = (id: string): PlayerState => {
  const tiles: TileSnapshot[] = [];
  for (const h of range(hex(0, 0), HIVE_RADIUS)) {
    const ri = ringIndex(h);
    if (ri === 0) tiles.push({ hex: h, state: 'hive', letter: null });
    else if (ri === 1) tiles.push({ hex: h, state: 'storage', letter: null });
    else tiles.push({ hex: h, state: 'active', letter: null });
  }
  return {
    id,
    honey: HIVE.startingHoney,
    hp: HIVE.startingHp,
    score: 0,
    tiles,
    bees: [],
    letterQueue: [],
    carpenterQueue: [],
  };
};

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

const spawnPatch = (
  existing: readonly FlowerPatch[],
  rng: () => number,
  spawnedAt: number,
): FlowerPatch | null => {
  const free = patchCenterCandidates.filter((c) =>
    existing.every((p) => cubeDistance(p.center, c) >= PATCH_MIN_CENTER_DISTANCE),
  );
  if (free.length === 0) return null;
  const center = free[Math.floor(rng() * free.length)]!;
  const type = PATCH_TYPES[Math.floor(rng() * PATCH_TYPES.length)]!;
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
  };
};

const seedPatches = (rng: () => number, t: number): FlowerPatch[] => {
  const result: FlowerPatch[] = [];
  while (result.length < PATCH_TARGET_COUNT) {
    const p = spawnPatch(result, rng, t);
    if (!p) break;
    result.push(p);
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

export const buildInitialWorld = (rng: () => number): World => ({
  t: 0,
  phase: 'playing',
  self: buildPlayer('self'),
  opponent: buildPlayer('opponent'),
  patches: seedPatches(rng, 0),
  patchCooldown: PATCH_RESPAWN_SECONDS,
  aiQueueCooldown: AI_QUEUE_BASE,
  aiSendCooldown: AI_SEND_BASE,
  aiPlaceCooldown: AI_PLACE_BASE,
  aiPhantomCooldown: AI_PHANTOM_BASE,
  aiCarpenterCooldown: AI_CARPENTER_BASE,
  winner: null,
  log: [],
});

// ---- Internal helpers ------------------------------------------------------

const setPlayer = (world: World, side: Side, player: PlayerState): World =>
  side === 'self' ? { ...world, self: player } : { ...world, opponent: player };

const otherSide = (side: Side): Side => (side === 'self' ? 'opponent' : 'self');

const sideHivePanel = (side: Side) =>
  side === 'self' ? ('self-hive' as const) : ('opponent-hive' as const);

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
  honey: Math.min(HIVE.maxHoney, player.honey + HIVE.honeyPerSecond * dt),
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

export const tickWorld = (world: World, dt: number, rng: () => number): World => {
  if (world.phase === 'over') return world;
  let next: World = {
    ...world,
    t: world.t + dt,
    self: tickHoney(world.self, dt),
    opponent: tickHoney(world.opponent, dt),
  };
  next = resolveArrivedBees(next);
  next = tickPatches(next, dt, rng);
  next = tickDummyAi(next, dt, rng);
  return checkVictory(next);
};

/**
 * Wither petals whose `witherAt` has elapsed, drop empty patches, and respawn
 * up to {@link PATCH_TARGET_COUNT} flowers (one per cooldown cycle so deaths
 * stagger visually).
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
  if (patches.length < PATCH_TARGET_COUNT) {
    if (cooldown <= 0) {
      const fresh = spawnPatch(patches, rng, world.t);
      if (fresh) {
        patches = [...patches, fresh];
        cooldown = PATCH_RESPAWN_SECONDS;
      }
    }
  } else {
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

const checkVictory = (world: World): World => {
  if (world.opponent.hp <= 0) return { ...world, phase: 'over', winner: 'self' };
  if (world.self.hp <= 0) return { ...world, phase: 'over', winner: 'opponent' };
  if (world.t >= ROUND_DURATION_SECONDS) {
    const winner: Side | null =
      world.self.score === world.opponent.score
        ? null
        : world.self.score > world.opponent.score
          ? 'self'
          : 'opponent';
    return { ...world, phase: 'over', winner };
  }
  return world;
};

// ---- Bee resolution --------------------------------------------------------

const resolveArrivedBees = (world: World): World => {
  let next = world;
  for (const side of ['self', 'opponent'] as const) {
    next = resolveSideBees(next, side);
  }
  return next;
};

const resolveSideBees = (world: World, side: Side): World => {
  const player = world[side];
  let next = world;
  let updatedPlayer = player;
  let updatedPatches = world.patches;
  let beesChanged = false;
  const remainingBees: Bee[] = [];

  for (const bee of player.bees) {
    const arrival = arrivalOf(bee);
    if (arrival === null || arrival > world.t) {
      remainingBees.push(bee);
      continue;
    }

    if (bee.state.kind === 'worker-flying-to-flower') {
      const target = bee.state.target;
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
                sideHivePanel(side),
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
              kind: 'worker-flying-to-drop',
              queue: bee.state.queue,
              carrying: found.petal.letter,
              dropTile: drop.hex,
              flight: flight(
                'flowers',
                target,
                sideHivePanel(side),
                drop.hex,
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
              sideHivePanel(side),
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

    if (bee.state.kind === 'worker-flying-to-drop') {
      const dropTile = bee.state.dropTile;
      const letter = bee.state.carrying;
      // Place into the chosen storage slot if still empty; otherwise try
      // another empty slot; otherwise the letter is lost.
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
              sideHivePanel(side),
              dropTile,
              'flowers',
              nextTarget,
              next.t,
              FLIGHT_TIMES.hiveToFlower,
            ),
          },
        });
      } else {
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: 'worker-returning',
            flight: flight(
              sideHivePanel(side),
              dropTile,
              sideHivePanel(side),
              hex(0, 0),
              next.t,
              FLIGHT_TIMES.hiveToHive,
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
      const allCappedHexes: Hex[] = [];
      for (const path of paths) {
        const letters: Letter[] = [];
        let valid = true;
        for (const h of path) {
          const tile = updatedPlayer.tiles.find((t) => hexEquals(t.hex, h));
          if (
            !tile ||
            (tile.state !== 'letter' && tile.state !== 'capped') ||
            !tile.letter
          ) {
            valid = false;
            break;
          }
          letters.push(tile.letter);
        }
        if (valid && letters.length >= 2) {
          wordsLetters.push(letters);
          for (const h of path) {
            if (!allCappedHexes.some((c) => hexEquals(c, h))) allCappedHexes.push(h);
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
        const sharesTile =
          wordsLetters.length >= 2 &&
          paths.some((p1, i) =>
            paths.some((p2, j) => i < j && p1.some((a) => p2.some((b) => hexEquals(a, b)))),
          );
        const score = sharesTile ? chainScore(wordsLetters) : wordsLetters.reduce((s, w) => s + wordScore(w), 0);
        const dmg = damageFor(score);
        updatedPlayer = {
          ...updatedPlayer,
          score: updatedPlayer.score + score,
          tiles: updatedPlayer.tiles.map((t) =>
            allCappedHexes.some((h) => hexEquals(h, t.hex))
              ? { ...t, state: 'capped' }
              : t,
          ),
        };
        const summary = wordsLetters.map((w) => w.join('')).join(' + ');
        const tag = sharesTile && wordsLetters.length >= 2 ? ' chain!' : '';
        next = logEvent(next, {
          t: next.t,
          ownerId: player.id,
          text: `${summary} +${score} pts${tag}`,
        });
        const opp = otherSide(side);
        const o = next[opp];
        next = setPlayer(next, opp, { ...o, hp: Math.max(0, o.hp - dmg) });
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
              { hex: target, state: 'active' as const, letter: null },
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
        remainingBees.push({
          ...bee,
          capacity: newCapacity,
          state: {
            kind: 'carpenter-flying',
            queue: rest,
            target: nextTarget,
            flight: flight(
              sideHivePanel(side),
              target,
              sideHivePanel(side),
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
              sideHivePanel(side),
              target,
              sideHivePanel(side),
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
  }

  if (beesChanged) {
    updatedPlayer = { ...updatedPlayer, bees: remainingBees };
  }
  next = setPlayer(next, side, updatedPlayer);
  if (updatedPatches !== world.patches) {
    next = { ...next, patches: updatedPatches };
  }
  return next;
};

const arrivalOf = (bee: Bee): number | null => {
  switch (bee.state.kind) {
    case 'worker-flying-to-flower':
    case 'worker-flying-to-drop':
    case 'worker-returning':
    case 'carpenter-flying':
    case 'carpenter-returning':
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

export const toggleLetterQueue = (world: World, side: Side, h: Hex): CommandResult => {
  const player = world[side];
  const exists = player.letterQueue.some((q) => hexEquals(q, h));
  if (exists) {
    return {
      ok: true,
      world: setPlayer(world, side, {
        ...player,
        letterQueue: player.letterQueue.filter((q) => !hexEquals(q, h)),
      }),
    };
  }
  if (player.letterQueue.length >= QUEUE_CAP) {
    return { ok: false, world, reason: `queue full (max ${QUEUE_CAP})` };
  }
  if (!petalAt(world.patches, h)) {
    return { ok: false, world, reason: 'no flower here' };
  }
  return {
    ok: true,
    world: setPlayer(world, side, {
      ...player,
      letterQueue: [...player.letterQueue, h],
    }),
  };
};

export const trySpawnWorker = (world: World, side: Side): CommandResult => {
  const player = world[side];
  const cost = BEE_STATS.worker.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (player.letterQueue.length === 0)
    return { ok: false, world, reason: 'no letters selected' };
  const emptyStorage = player.tiles.some((t) => t.state === 'storage' && !t.letter);
  if (!emptyStorage)
    return { ok: false, world, reason: 'storage is full' };

  const [target, ...rest] = player.letterQueue;
  if (!target) return { ok: false, world, reason: 'no letters selected' };

  const bee: Bee = {
    id: newId(),
    kind: 'worker',
    ownerId: player.id,
    capacity: BEE_STATS.worker.capacity,
    state: {
      kind: 'worker-flying-to-flower',
      queue: rest,
      target,
      flight: flight(
        sideHivePanel(side),
        hex(0, 0),
        'flowers',
        target,
        world.t,
        FLIGHT_TIMES.hiveToFlower,
      ),
    },
  };

  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
    letterQueue: [],
  };
  return { ok: true, world: setPlayer(world, side, updated) };
};

/**
 * Move a letter from a storage slot onto an empty active tile. The letter
 * locks once placed — its only future is to be capped by a drone.
 */
export const placeLetter = (
  world: World,
  side: Side,
  fromHex: Hex,
  toHex: Hex,
): CommandResult => {
  const player = world[side];
  const source = player.tiles.find((t) => hexEquals(t.hex, fromHex));
  if (!source || source.state !== 'storage' || !source.letter) {
    return { ok: false, world, reason: 'no letter in that storage slot' };
  }
  const dest = player.tiles.find((t) => hexEquals(t.hex, toHex));
  if (!dest || dest.state !== 'active' || dest.letter) {
    return { ok: false, world, reason: 'destination is not an empty active tile' };
  }
  const letter = source.letter;
  const updated: PlayerState = {
    ...player,
    tiles: player.tiles.map((t) => {
      if (hexEquals(t.hex, fromHex)) return { ...t, letter: null };
      if (hexEquals(t.hex, toHex)) return { ...t, state: 'letter', letter };
      return t;
    }),
  };
  return { ok: true, world: setPlayer(world, side, updated) };
};

/**
 * Submit one or more drafted word paths for capping. Each path must be at
 * least 2 tiles, contiguous, and pass only over `letter` or `capped` tiles
 * (capped tiles are the branch points of the Scrabble model). Up to
 * `drone.capacity` paths are accepted per submission.
 */
export const trySubmitWord = (
  world: World,
  side: Side,
  paths: readonly (readonly Hex[])[],
): CommandResult => {
  const player = world[side];
  const cost = BEE_STATS.drone.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (paths.length === 0) return { ok: false, world, reason: 'no words submitted' };
  if (paths.length > BEE_STATS.drone.capacity)
    return {
      ok: false,
      world,
      reason: `too many words (max ${BEE_STATS.drone.capacity})`,
    };
  for (const path of paths) {
    if (path.length < 2) return { ok: false, world, reason: 'word too short' };
    if (!isValidPath(path)) return { ok: false, world, reason: 'path is not contiguous' };
    for (const h of path) {
      const tile = player.tiles.find((t) => hexEquals(t.hex, h));
      if (
        !tile ||
        (tile.state !== 'letter' && tile.state !== 'capped') ||
        !tile.letter
      ) {
        return { ok: false, world, reason: 'path includes a non-letter tile' };
      }
    }
  }
  const flightSeconds = FLIGHT_TIMES.cappingPerPath * paths.length;
  const bee: Bee = {
    id: newId(),
    kind: 'drone',
    ownerId: player.id,
    capacity: BEE_STATS.drone.capacity,
    state: {
      kind: 'capping',
      panel: sideHivePanel(side),
      paths,
      startedAt: world.t,
      arrivesAt: world.t + flightSeconds,
    },
  };
  const updated: PlayerState = {
    ...player,
    honey: player.honey - cost,
    bees: [...player.bees, bee],
  };
  return { ok: true, world: setPlayer(world, side, updated) };
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

export const toggleCarpenterTarget = (
  world: World,
  side: Side,
  h: Hex,
): CommandResult => {
  const player = world[side];
  const exists = player.carpenterQueue.some((q) => hexEquals(q, h));
  if (exists) {
    return {
      ok: true,
      world: setPlayer(world, side, {
        ...player,
        carpenterQueue: player.carpenterQueue.filter((q) => !hexEquals(q, h)),
      }),
    };
  }
  if (player.carpenterQueue.length >= CARPENTER_QUEUE_CAP) {
    return {
      ok: false,
      world,
      reason: `carpenter queue full (max ${CARPENTER_QUEUE_CAP})`,
    };
  }
  if (!isCarpenterEligible(player, h)) {
    return { ok: false, world, reason: 'tile must touch your hive' };
  }
  return {
    ok: true,
    world: setPlayer(world, side, {
      ...player,
      carpenterQueue: [...player.carpenterQueue, h],
    }),
  };
};

export const trySpawnCarpenter = (world: World, side: Side): CommandResult => {
  const player = world[side];
  const cost = BEE_STATS.carpenter.honeyCost;
  if (player.honey < cost) return { ok: false, world, reason: 'not enough honey' };
  if (player.carpenterQueue.length === 0)
    return { ok: false, world, reason: 'no tiles selected' };

  const [target, ...rest] = player.carpenterQueue;
  if (!target) return { ok: false, world, reason: 'no tiles selected' };

  const bee: Bee = {
    id: newId(),
    kind: 'carpenter',
    ownerId: player.id,
    capacity: BEE_STATS.carpenter.capacity,
    state: {
      kind: 'carpenter-flying',
      queue: rest,
      target,
      flight: flight(
        sideHivePanel(side),
        hex(0, 0),
        sideHivePanel(side),
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
    carpenterQueue: [],
  };
  return { ok: true, world: setPlayer(world, side, updated) };
};

// ---- Dummy AI --------------------------------------------------------------

const tickDummyAi = (world: World, dt: number, rng: () => number): World => {
  let next = world;
  let {
    aiQueueCooldown,
    aiSendCooldown,
    aiPlaceCooldown,
    aiPhantomCooldown,
    aiCarpenterCooldown,
  } = next;
  aiQueueCooldown -= dt;
  aiSendCooldown -= dt;
  aiPlaceCooldown -= dt;
  aiPhantomCooldown -= dt;
  aiCarpenterCooldown -= dt;

  if (aiQueueCooldown <= 0) {
    const allPetals = next.patches.flatMap((p) => p.petals.map((pt) => pt.hex));
    if (next.opponent.letterQueue.length < 3 && allPetals.length > 0) {
      const available = allPetals.filter(
        (h) => !next.opponent.letterQueue.some((q) => hexEquals(q, h)),
      );
      if (available.length > 0) {
        const pick = available[Math.floor(rng() * available.length)]!;
        const r = toggleLetterQueue(next, 'opponent', pick);
        if (r.ok) next = r.world;
      }
    }
    aiQueueCooldown = AI_QUEUE_BASE + rng() * 2;
  }

  if (aiSendCooldown <= 0) {
    if (next.opponent.letterQueue.length > 0) {
      const r = trySpawnWorker(next, 'opponent');
      if (r.ok) next = r.world;
    }
    aiSendCooldown = AI_SEND_BASE + rng() * 3;
  }

  if (aiPlaceCooldown <= 0) {
    // Place the first stored letter onto the first empty active tile.
    const filledStorage = next.opponent.tiles.find(
      (t) => t.state === 'storage' && t.letter !== null,
    );
    const emptyActive = next.opponent.tiles.find(
      (t) => t.state === 'active' && !t.letter,
    );
    if (filledStorage && emptyActive) {
      const r = placeLetter(next, 'opponent', filledStorage.hex, emptyActive.hex);
      if (r.ok) next = r.world;
    }
    aiPlaceCooldown = AI_PLACE_BASE + rng() * 2;
  }

  if (aiPhantomCooldown <= 0) {
    next = simulatePhantomWord(next, rng);
    aiPhantomCooldown = AI_PHANTOM_BASE + rng() * 4;
  }

  if (aiCarpenterCooldown <= 0) {
    // Queue an eligible inactive tile and dispatch a carpenter when honey allows.
    const ai = next.opponent;
    const pending = ai.bees.some(
      (b) => b.kind === 'carpenter' || b.state.kind === 'carpenter-flying',
    );
    if (!pending) {
      const eligible = ai.tiles.filter(
        (t) =>
          t.state === 'inactive' &&
          neighbors(t.hex).some((n) => {
            const nb = ai.tiles.find((tt) => hexEquals(tt.hex, n));
            return (
              !!nb &&
              (nb.state === 'active' || nb.state === 'letter' || nb.state === 'capped')
            );
          }) &&
          !ai.carpenterQueue.some((q) => hexEquals(q, t.hex)),
      );
      if (eligible.length > 0) {
        const pick = eligible[Math.floor(rng() * eligible.length)]!;
        const r = toggleCarpenterTarget(next, 'opponent', pick.hex);
        if (r.ok) next = r.world;
      }
      if (
        next.opponent.carpenterQueue.length > 0 &&
        next.opponent.honey >= BEE_STATS.carpenter.honeyCost
      ) {
        const sr = trySpawnCarpenter(next, 'opponent');
        if (sr.ok) next = sr.world;
      }
    }
    aiCarpenterCooldown = AI_CARPENTER_BASE + rng() * 6;
  }

  return {
    ...next,
    aiQueueCooldown,
    aiSendCooldown,
    aiPlaceCooldown,
    aiPhantomCooldown,
    aiCarpenterCooldown,
  };
};

const simulatePhantomWord = (world: World, rng: () => number): World => {
  const length = 3 + Math.floor(rng() * 3);
  const letters: Letter[] = [];
  // Phantom words mix vowels and common consonants — gives the AI a believable
  // spread without needing actual letters on its board.
  const pool = [...FLOWER_LETTER_POOLS.vowel, ...FLOWER_LETTER_POOLS.common];
  for (let i = 0; i < length; i++) {
    letters.push(pool[Math.floor(rng() * pool.length)]!);
  }
  const score = wordScore(letters);
  const dmg = damageFor(score);
  let next = world;
  next = setPlayer(next, 'opponent', {
    ...next.opponent,
    score: next.opponent.score + score,
  });
  next = setPlayer(next, 'self', {
    ...next.self,
    hp: Math.max(0, next.self.hp - dmg),
  });
  next = logEvent(next, {
    t: next.t,
    ownerId: next.opponent.id,
    text: `${letters.join('')} +${score} pts`,
  });
  return next;
};
