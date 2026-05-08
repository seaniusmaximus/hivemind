import type { Hex } from './hex.js';
import type { Letter } from './letters.js';

export type BeeKind = 'worker' | 'carpenter' | 'drone' | 'queen';

export interface BeeStats {
  readonly capacity: number;
  readonly honeyCost: number;
  /** Default cross-panel flight duration, in seconds. Per-segment durations
   *  used by the engine may shorten this for short hops. */
  readonly flightSeconds: number;
}

export const BEE_STATS: Readonly<Record<BeeKind, BeeStats>> = {
  // Workers and carpenters are now single-trip dispatches: each hold-to-send
  // gesture spawns one bee that visits exactly one target and returns.
  worker: { capacity: 1, honeyCost: 3, flightSeconds: 1.5 },
  carpenter: { capacity: 1, honeyCost: 5, flightSeconds: 1.2 },
  // Drone caps are free — words pay you, they never charge you.
  drone: { capacity: 2, honeyCost: 0, flightSeconds: 1.6 },
  queen: { capacity: 1, honeyCost: 20, flightSeconds: 10 },
};

/**
 * Hive economy constants.
 *
 * Honey is the only resource. It is generated passively at a rate
 * proportional to your hive size, and stored up to a cap that scales with
 * how many honeycomb hexes you own. Word caps and chains pay out additional
 * honey on top.
 *
 * - `regenPerHex` is multiplied by the total number of owned hex tiles
 *   (hive + storage + active + letter + capped) to get your per-second base
 *   rate.
 * - `cappedHoneyBonus` is added on top once per capped letter the player owns,
 *   so locking in words materially boosts your sustained production.
 * - The honey cap is the sum of:
 *   - {@link HIVE.hiveStorage} for the central hive tile, and
 *   - 1 for every owned tile that is *not* the central hive and *not* a
 *     letter-storage slot (i.e. active / letter / capped tiles).
 *   So a fresh hive (1 hive + 6 storage + 12 active) starts at
 *   `5 + 12 = 17`. Carpenters grow the cap by adding active tiles; queen
 *   damage shrinks it by destroying them.
 */
export const HIVE = {
  startingHoney: 5,
  /** Honey regenerated per second, per owned hex tile. */
  regenPerHex: 0.04,
  /** Extra honey/sec each capped letter contributes on top of `regenPerHex`. */
  cappedHoneyBonus: 0.08,
  /** Capacity contributed by the central hive tile itself. */
  hiveStorage: 5,
} as const;

/**
 * Owned hexes required per additional queen slot. A player can have one queen
 * active at a time by default, plus one extra for every full multiple of
 * {@link HEXES_PER_QUEEN_SLOT} hexes they own. Big hives field swarms.
 */
export const HEXES_PER_QUEEN_SLOT = 12;

/** Per-segment flight times (seconds). */
export const FLIGHT_TIMES = {
  hiveToFlower: 1.5,
  flowerToHive: 1.5,
  flowerToFlower: 0.5,
  hiveToHive: 0.5,
  hiveToTile: 0.7,
  tileToTile: 0.5,
  tileToHive: 0.7,
  /** Drone time to walk a single word path. Total cap time scales with path count. */
  cappingPerPath: 1.4,
  queenToHive: 10,
} as const;

/** Identifies which on-screen panel a bee waypoint lives in. */
export type BeePanel = 'self-hive' | 'flowers' | 'opponent-hive';

export interface BeeWaypoint {
  readonly panel: BeePanel;
  readonly hex: Hex;
}

export interface BeeFlight {
  readonly from: BeeWaypoint;
  readonly to: BeeWaypoint;
  readonly startedAt: number;
  readonly arrivesAt: number;
}

export interface Bee {
  readonly id: string;
  readonly kind: BeeKind;
  readonly ownerId: string;
  /** Remaining capacity (decremented as the bee performs actions). */
  readonly capacity: number;
  readonly state: BeeState;
}

export type BeeState =
  | {
      readonly kind: 'worker-flying-to-flower';
      /** Remaining flowers to visit after the current target. */
      readonly queue: readonly Hex[];
      /** The flower this bee is currently heading to. */
      readonly target: Hex;
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'worker-flying-to-drop';
      readonly queue: readonly Hex[];
      readonly carrying: Letter;
      readonly dropTile: Hex;
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'worker-flying-to-freed';
      readonly target: Hex;
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'worker-returning';
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'carpenter-flying';
      readonly queue: readonly Hex[];
      readonly target: Hex;
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'carpenter-returning';
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'capping';
      readonly panel: 'self-hive' | 'opponent-hive';
      /** One or more word paths capped by the same drone flight. */
      readonly paths: readonly (readonly Hex[])[];
      readonly startedAt: number;
      readonly arrivesAt: number;
    }
  | {
      readonly kind: 'queen-flying';
      /** Final attack panel (defender side), used after the flight lands. */
      readonly assaultPanel: 'self-hive' | 'opponent-hive';
      /** Hex on the defender's grid where the queen lands. */
      readonly landingHex: Hex;
      /** Engine-time at which the assault phase ends. */
      readonly expiresAt: number;
      readonly flight: BeeFlight;
    }
  | {
      readonly kind: 'queen-assault';
      readonly panel: 'self-hive' | 'opponent-hive';
      readonly currentHex: Hex;
      readonly expiresAt: number;
      readonly nextActionAt: number;
    };

/** Convenience accessor — returns the bee's current `BeeFlight`, if any. */
export const beeFlight = (state: BeeState): BeeFlight | null => {
  switch (state.kind) {
    case 'worker-flying-to-flower':
    case 'worker-flying-to-drop':
    case 'worker-flying-to-freed':
    case 'worker-returning':
    case 'carpenter-flying':
    case 'carpenter-returning':
    case 'queen-flying':
      return state.flight;
    default:
      return null;
  }
};
