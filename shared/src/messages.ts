import type { Hex } from './hex.js';
import type { FlowerType, Letter } from './letters.js';
import type { Bee, BeeKind } from './bees.js';

/** ----- Client → Server ----- */

export type ClientMessage =
  | { type: 'JOIN_ROOM'; roomCode: string; playerName: string }
  | { type: 'CREATE_ROOM'; playerName: string }
  | { type: 'READY' }
  | { type: 'SPAWN_BEE'; bee: BeeKind }
  | {
      type: 'ASSIGN_BEE_TARGET';
      beeId: string;
      target:
        | { kind: 'flower'; flower: Hex; dropOn: Hex }
        | { kind: 'tile'; tile: Hex }
        | { kind: 'word'; path: readonly Hex[] };
    }
  | { type: 'LEAVE' };

/** ----- Server → Client ----- */

export type ServerMessage =
  | { type: 'ROOM_STATE'; roomCode: string; players: PlayerSummary[]; phase: GamePhase }
  | { type: 'GAME_START'; seed: number; opponentId: string; tickRate: number }
  | { type: 'TICK'; tick: number; snapshot: GameSnapshot }
  | { type: 'BEE_EVENT'; ownerId: string; bee: Bee }
  | { type: 'FLOWER_EVENT'; flowers: readonly FlowerSnapshot[] }
  | {
      type: 'WORD_RESULT';
      ownerId: string;
      words: readonly { letters: readonly Letter[]; valid: boolean }[];
      score: number;
      damage: number;
    }
  | { type: 'GAME_OVER'; winnerId: string | null; reason: 'time' | 'hp' | 'forfeit' }
  | { type: 'ERROR'; code: string; message: string };

export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'over';

export interface PlayerSummary {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
}

/**
 * One pickable letter on the field. A petal lives on a single hex inside a
 * `FlowerPatch`. Bees target petals by hex; when a bee arrives we look the
 * petal up via its containing patch.
 */
export interface Petal {
  readonly hex: Hex;
  readonly letter: Letter;
  /** Engine-time at which this petal naturally falls off. */
  readonly witherAt: number;
}

/**
 * A flower patch: an unused center hex with up to six petal hexes around it.
 * Petals fall off one by one as `witherAt` passes; once empty (collected or
 * fully withered) the patch despawns and a new one spawns elsewhere.
 */
export interface FlowerPatch {
  readonly id: string;
  readonly type: FlowerType;
  readonly center: Hex;
  readonly petals: readonly Petal[];
  readonly spawnedAt: number;
  /** Total intended lifetime of the patch in seconds (informational). */
  readonly lifetimeSeconds: number;
}

/** Back-compat: a single pickable petal flattened for older consumers. */
export interface FlowerSnapshot {
  readonly hex: Hex;
  readonly letter: Letter;
  readonly type: FlowerType;
  readonly patchId: string;
}

export interface GameSnapshot {
  readonly tick: number;
  readonly time: number;
  readonly self: PlayerState;
  readonly opponent: PlayerState;
  readonly patches: readonly FlowerPatch[];
}

export interface PlayerState {
  readonly id: string;
  /** The only player resource. Spent on bees and word caps; honey at the
   *  round timer is the win metric (tiebreak: hive size). */
  readonly honey: number;
  readonly tiles: readonly TileSnapshot[];
  readonly bees: readonly Bee[];
  /** Flower hexes selected by this player, in selection order. Consumed by SEND WORKER. */
  readonly letterQueue: readonly Hex[];
  /** Inactive tile hexes selected for activation. Consumed by SEND CARPENTER. */
  readonly carpenterQueue: readonly Hex[];
}

export interface TileSnapshot {
  readonly hex: Hex;
  /**
   * - `hive`: central hive tile (radius 0). Not playable.
   * - `storage`: one of the six slots adjacent to the hive (radius 1). Holds a
   *   delivered-but-unplaced letter. Empty when `letter === null`.
   * - `active`: empty playable tile. Initially seeded at radius 2; carpenters
   *   add new active tiles outward indefinitely. Letters dragged from storage
   *   land here.
   * - `letter`: an active tile that holds a placed (locked) letter. Word
   *   drafts walk these tiles.
   * - `capped`: a letter tile that has been scored by a drone. Still draftable
   *   as a branch point.
   * - `inactive`: legacy state — preserved for back-compat. The renderer now
   *   shows the carpenter-eligible *frontier* (any hex adjacent to your
   *   active/letter/capped tiles) without storing inactive tiles in the
   *   PlayerState.
   */
  readonly state: 'hive' | 'storage' | 'inactive' | 'active' | 'letter' | 'capped';
  readonly letter: Letter | null;
}
