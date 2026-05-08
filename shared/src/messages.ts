import type { Hex } from './hex.js';
import type { FlowerType, Letter } from './letters.js';
import type { Bee } from './bees.js';

/** ----- Engine + wire shared primitives ----- */

/** Which side of the board a player or piece belongs to from one viewer's
 *  perspective. The server stores both sides absolutely; clients always see
 *  themselves as `'self'` regardless of who they are in the room. */
export type Side = 'self' | 'opponent';

/** Engine-local lifecycle. Distinct from the lobby-aware {@link GamePhase}
 *  below — the engine only cares whether play is ongoing or finished. */
export type WorldPhase = 'playing' | 'over';

/** Lobby-aware lifecycle for the room as a whole. */
export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'over';

/** One entry in the engine's rolling activity feed. Purely informational —
 *  game state is *not* derived from log entries. */
export interface ActivityEntry {
  readonly id: string;
  readonly t: number;
  readonly ownerId: string;
  readonly text: string;
}

/** ----- Client → Server ----- */

/**
 * The set of gameplay actions a client can request. The server validates each
 * command against the requesting player's side before applying it; the
 * authoritative engine then folds the result into the next snapshot.
 */
export type GameCommand =
  | { readonly kind: 'dispatchWorker'; readonly target: Hex }
  | { readonly kind: 'dispatchCarpenter'; readonly target: Hex }
  | { readonly kind: 'dispatchQueen' }
  | { readonly kind: 'placeLetter'; readonly from: Hex; readonly to: Hex }
  | { readonly kind: 'submitWords'; readonly paths: readonly (readonly Hex[])[] };

/** Discriminator for {@link GameCommand}. Useful for log lines and switches. */
export type GameCommandKind = GameCommand['kind'];

export type ClientMessage =
  /** First message after the WebSocket opens; identifies the player.
   *  Room creation/lookup happens out-of-band (HTTP `POST /api/rooms` to mint
   *  a code, then the client connects to `/ws/<code>`). The DO that owns the
   *  code keys players in by HELLO; first-in becomes host, second is joiner. */
  | { type: 'HELLO'; playerName: string }
  | { type: 'READY' }
  | { type: 'LEAVE' }
  | {
      type: 'COMMAND';
      /** Client-generated request id; echoed back in `COMMAND_RESULT`. */
      commandId: string;
      cmd: GameCommand;
    };

/** ----- Server → Client ----- */

export type ServerMessage =
  | { type: 'ROOM_STATE'; roomCode: string; players: readonly PlayerSummary[]; phase: GamePhase }
  | {
      type: 'GAME_START';
      /** This client's player id (perspective: `self` in snapshots). */
      selfId: string;
      /** The other player's id (perspective: `opponent` in snapshots). */
      opponentId: string;
      /** RNG seed used by the authoritative engine. Clients echo this for
       *  any client-only random visuals so we don't desync. */
      seed: number;
      /** Server snapshot rate in Hz. */
      tickRate: number;
      /** Wall-clock ms when the round began. */
      startedAt: number;
    }
  | { type: 'SNAPSHOT'; tick: number; world: WorldSnapshot }
  | {
      type: 'COMMAND_RESULT';
      commandId: string;
      ok: boolean;
      /** Present when `ok === false`; matches the engine's CommandResult.reason. */
      reason?: string;
    }
  | {
      type: 'WORD_RESULT';
      ownerId: string;
      /** One entry per drafted path in the original submit, in input order. */
      words: readonly { readonly letters: readonly Letter[]; readonly valid: boolean }[];
    }
  | {
      type: 'GAME_OVER';
      winnerId: string | null;
      reason: 'queen' | 'forfeit';
    }
  | { type: 'ERROR'; code: string; message: string };

export interface PlayerSummary {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
}

/** ----- World snapshot (S → C) ----- */

/**
 * The portion of the engine `World` that crosses the wire. Solo and
 * authoritative ticks share the same shape so the renderer doesn't care which
 * source produced it. AI cooldowns and engine-private bookkeeping are
 * deliberately excluded.
 */
export interface WorldSnapshot {
  /** Engine seconds since round start. */
  readonly t: number;
  /** Server-side monotonic snapshot index (0 in solo). */
  readonly tick: number;
  readonly phase: WorldPhase;
  /** From the receiver's perspective. `'self'` means the receiver won. */
  readonly winner: Side | null;
  readonly self: PlayerState;
  readonly opponent: PlayerState;
  readonly patches: readonly FlowerPatch[];
  readonly log: readonly ActivityEntry[];
}

/** ----- Flower field ----- */

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

/** ----- Player state ----- */

export interface PlayerState {
  readonly id: string;
  /** The only player resource. Spent on bees and word caps; honey at the
   *  round timer is the win metric (tiebreak: hive size). */
  readonly honey: number;
  readonly tiles: readonly TileSnapshot[];
  readonly freedLetters?: readonly FreedLetter[];
  readonly bees: readonly Bee[];
  /** Signatures for already-submitted word+hex patterns to prevent replaying
   *  the exact same word with the exact same tile letters. */
  readonly usedWordSignatures: readonly string[];
}

export interface FreedLetter {
  readonly id: string;
  readonly hex: Hex;
  readonly letter: Letter;
  readonly spawnedAt: number;
  readonly witherAt: number;
}

export interface TileSnapshot {
  readonly hex: Hex;
  /**
   * - `hive`: central hive tile (radius 0). Not playable.
   * - `storage`: one of the six slots adjacent to the hive (radius 1). Holds a
   *   delivered-but-unplaced letter. Empty when `letter === null`.
   * - `active`: playable honeycomb tile. May be empty (`letter === null`) or
   *   hold an uncapped letter until a drone scores it (`capped`).
   * - `letter`: legacy — placed letter awaiting a cap; treated like `active` +
   *   a letter for drafting and movement.
   * - `capped`: a letter tile that has been scored by a drone. Still draftable
   *   as a branch point.
   * - `inactive`: legacy state — preserved for back-compat. The renderer now
   *   shows the carpenter-eligible *frontier* (any hex adjacent to your
   *   active/letter/capped tiles) without storing inactive tiles in the
   *   PlayerState.
   */
  readonly state: 'hive' | 'storage' | 'inactive' | 'active' | 'letter' | 'capped';
  readonly letter: Letter | null;
  /** Damage dealt by queen attacks. Tile is destroyed when this reaches HP. */
  readonly damage?: number;
  /**
   * Number of times this hex has been reused *after* first being capped.
   * A capped tile starts at 0 and gains +1 for each additional successful word
   * submission that includes it.
   */
  readonly reuseCount?: number;
}
