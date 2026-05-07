import type { Hex } from './hex.js';
import type { Letter } from './letters.js';

export type BeeKind = 'worker' | 'carpenter' | 'drone';

export interface BeeStats {
  readonly capacity: number;
  readonly honeyCost: number;
  /** Default cross-panel flight duration, in seconds. Per-segment durations
   *  used by the engine may shorten this for short hops. */
  readonly flightSeconds: number;
}

export const BEE_STATS: Readonly<Record<BeeKind, BeeStats>> = {
  worker: { capacity: 5, honeyCost: 3, flightSeconds: 1.5 },
  carpenter: { capacity: 2, honeyCost: 5, flightSeconds: 1.2 },
  drone: { capacity: 2, honeyCost: 7, flightSeconds: 1.6 },
};

/**
 * Hive economy constants.
 *
 * Honey is the only resource. It is generated passively at a rate
 * proportional to your hive size, and stored up to a cap that scales with
 * how many *empty* active tiles you have (room in the comb). Word caps and
 * chains pay out additional honey on top.
 *
 * - `regenPerHex` is multiplied by the total number of owned hex tiles
 *   (hive + storage + active + letter + capped) to get your per-second rate.
 * - `capBase + capPerEmptyTile * emptyActiveCount` gives your honey ceiling.
 *   Filling tiles with letters reduces your headroom; growing the hive with
 *   carpenters raises both your rate and (when the new tile is empty) your
 *   cap.
 */
export const HIVE = {
  startingHoney: 5,
  /** Honey regenerated per second, per owned hex tile. */
  regenPerHex: 0.04,
  /** Baseline honey storage cap (independent of hive size). */
  capBase: 10,
  /** Additional cap room contributed by each empty active tile. */
  capPerEmptyTile: 2,
} as const;

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
    };

/** Convenience accessor — returns the bee's current `BeeFlight`, if any. */
export const beeFlight = (state: BeeState): BeeFlight | null => {
  switch (state.kind) {
    case 'worker-flying-to-flower':
    case 'worker-flying-to-drop':
    case 'worker-returning':
    case 'carpenter-flying':
    case 'carpenter-returning':
      return state.flight;
    default:
      return null;
  }
};
