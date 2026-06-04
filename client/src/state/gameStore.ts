import { create } from 'zustand';
import {
  activeQueenCountFor,
  applyCommand as engineApplyCommand,
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
  AI_DIFFICULTIES,
  buildInitialWorld,
  frontierFor,
  getPlayer,
  joinIndexOf,
  opponentSlotForJoinIndex,
  setPlayerById,
  type OpponentSlot,
  type AiDifficulty,
  hexEquals,
  hexKey,
  isAdjacent,
  makeRng,
  queenAllowanceFor,
  tickSolo,
  tickWorld,
  resolveWordFromPath,
  SPECIAL_TILE_KINDS,
  tileHasDraftableLetter,
  type BeePanel,
  type CommandResult,
  type GameCommand,
  type GamePhase,
  type Hex,
  type Letter,
  type PlayerState,
  type PlayerSummary,
  type QueenAttackSide,
  type ServerMessage,
  type Side,
  type SpecialTileKind,
  type TileSnapshot,
  type World,
  type WorldSnapshot,
} from '@hivemind/shared';
import { playCommandSfx } from '../game/audio/sfx.js';
import { drainWordCapHoneyToasts } from '../game/wordCapHoneyToast.js';
import { resetWordCapHoneyToastSeen } from '../game/wordCapHoneyToastSeen.js';
import { wordStatus } from '../game/dictionary.js';
import {
  createRoomCode,
  openRoomConnection,
  type ConnectionStatus,
  type NetConnection,
} from '../game/net/connection.js';
import type { TutorialStepId } from '../game/tutorialSteps.js';

const TUTORIAL_PREF_KEY = 'hivemind-tutorial';
/** If no carpenter appears (edge case), still advance after this long. */
const TUTORIAL_CARPENTER_WAIT_FALLBACK_MS = 5000;

const readTutorialPref = (): boolean => {
  try {
    return localStorage.getItem(TUTORIAL_PREF_KEY) === '1';
  } catch {
    return false;
  }
};

const writeTutorialPref = (on: boolean): void => {
  try {
    localStorage.setItem(TUTORIAL_PREF_KEY, on ? '1' : '0');
  } catch {
    // Private mode / blocked storage — ignore.
  }
};

const injectStorageLetters = (world: ClientWorld, letters: readonly Letter[]): ClientWorld => {
  let i = 0;
  const tiles = world.self.tiles.map((t) => {
    if (t.state === 'storage' && !t.letter && i < letters.length) {
      const letter = letters[i]!;
      i += 1;
      return { ...t, letter };
    }
    return t;
  });
  return toClientWorld(
    setPlayerById(world, world.self.id, { ...world.self, tiles }),
    world.self.id,
  );
};

const selfHasWorkerInFlight = (world: ClientWorld): boolean =>
  world.self.bees.some(
    (b) =>
      b.state.kind === 'worker-flying-to-flower' ||
      b.state.kind === 'worker-flying-to-door-carrying' ||
      b.state.kind === 'worker-flying-to-freed' ||
      b.state.kind === 'worker-returning',
  );

const storageHasLetter = (world: ClientWorld): boolean =>
  world.self.tiles.some((t) => t.state === 'storage' && t.letter !== null);

/** Matches {@link QueenSpawnButton} — spawn is allowed (not merely targeting). */
const selfHasCappingBee = (world: ClientWorld): boolean =>
  world.self.bees.some((b) => b.state.kind === 'capping');

const selfHasCarpenterBusy = (world: ClientWorld): boolean =>
  world.self.bees.some(
    (b) =>
      b.kind === 'carpenter' &&
      (b.state.kind === 'carpenter-flying' || b.state.kind === 'carpenter-returning'),
  );

/** B, E, E capped on the comb after the drone finishes "bee". */
const hasBeeWordCappedOnComb = (world: ClientWorld): boolean => {
  let b = 0;
  let e = 0;
  for (const t of world.self.tiles) {
    if (t.state !== 'capped' || !t.letter) continue;
    if (t.letter === 'B') b += 1;
    else if (t.letter === 'E') e += 1;
  }
  return b >= 1 && e >= 2;
};

/** B, E, E, S capped after spelling "bees" with reused letters. */
const hasBeesWordCappedOnComb = (world: ClientWorld): boolean => {
  let b = 0;
  let e = 0;
  let s = 0;
  for (const t of world.self.tiles) {
    if (t.state !== 'capped' || !t.letter) continue;
    if (t.letter === 'B') b += 1;
    else if (t.letter === 'E') e += 1;
    else if (t.letter === 'S') s += 1;
  }
  return b >= 1 && e >= 2 && s >= 1;
};

/** B, E, E dragged from storage onto empty comb tiles (ready to swipe a word). */
const hasBeeLettersOnComb = (world: ClientWorld): boolean => {
  let b = 0;
  let e = 0;
  for (const t of world.self.tiles) {
    if (t.state === 'storage' || t.state === 'capped' || t.state === 'hive') continue;
    if (t.state !== 'active' && t.state !== 'letter') continue;
    if (!t.letter) continue;
    if (t.letter === 'B') b += 1;
    else if (t.letter === 'E') e += 1;
  }
  return b >= 1 && e >= 2;
};

const canSpawnQueenNow = (world: ClientWorld): boolean => {
  const self = world.self;
  const allowance = queenAllowanceFor(self);
  const activeQueens = activeQueenCountFor(self);
  if (activeQueens >= allowance) return false;
  if (self.tiles.length < QUEEN_MIN_OWNED_HEXES) return false;
  return self.honey >= BEE_STATS.queen.honeyCost;
};

const padTilesForQueenMin = (player: PlayerState): PlayerState => {
  let next = player;
  while (next.tiles.length < QUEEN_MIN_OWNED_HEXES) {
    const f = frontierFor(next);
    const h = f[0];
    if (!h) return next;
    next = {
      ...next,
      tiles: [
        ...next.tiles,
        { hex: h, state: 'active' as const, letter: null, reuseCount: 0, damage: 0 },
      ],
    };
  }
  return next;
};

export type PanelIndex = 0 | 1 | 2 | 3 | 4;

/** Client view of the world: engine state plus viewer-relative player shortcuts. */
export type ClientWorld = World & {
  readonly self: PlayerState;
  readonly opponents: readonly PlayerState[];
  /** First rival (2-player compat). */
  readonly opponent: PlayerState;
};

const isRivalEliminated = (world: ClientWorld, rivalId: string): boolean =>
  world.eliminatedPlayerIds.includes(rivalId);

const firstActiveRivalIndex = (world: ClientWorld): number => {
  const i = world.opponents.findIndex((o) => !isRivalEliminated(world, o.id));
  return i >= 0 ? i : 0;
};

const queenTargetRival = (world: ClientWorld, index: number): PlayerState | undefined => {
  const rival = world.opponents[index];
  if (!rival || isRivalEliminated(world, rival.id)) return undefined;
  return rival;
};

const rivalSlotOrder = (world: World, selfId: string): readonly PlayerState[] => {
  const slotOrder = ['right', 'above', 'below'] as const;
  return world.playerIds
    .filter((id) => id !== selfId)
    .map((id) => ({ player: getPlayer(world, id), slot: opponentSlotForJoinIndex(joinIndexOf(world, id)) }))
    .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot))
    .map((r) => r.player);
};

const toClientWorld = (world: World, selfId: string, snap?: WorldSnapshot): ClientWorld => {
  const self = snap ? snap.self : getPlayer(world, selfId);
  const opponents = snap ? snap.opponents : rivalSlotOrder(world, selfId);
  return {
    ...world,
    self,
    opponents,
    opponent: opponents[0] ?? self,
  };
};

const wrapSoloWorld = (world: World): ClientWorld => toClientWorld(world, 'self');

export interface LetterDrag {
  readonly fromHex: Hex;
  readonly letter?: Letter;
  readonly specialKind?: SpecialTileKind;
}

/**
 * Floating, contextual feedback popup. Toasts are anchored to a (panel, hex)
 * waypoint so they emanate from the tile the user actually interacted with —
 * "not enough honey" rises out of the petal that was just held, not some
 * unrelated corner of the screen. They self-expire after `TOAST_LIFETIME_MS`
 * and the renderer animates the rise + fade based on elapsed time.
 */
export interface Toast {
  readonly id: string;
  readonly text: string;
  readonly panel: BeePanel;
  readonly hex: Hex;
  readonly variant: 'error' | 'info' | 'alert';
  /** Defaults to {@link TOAST_LIFETIME_MS} when omitted. */
  readonly lifetimeMs?: number;
  /** `performance.now()` at creation; used to drive rise + fade animations. */
  readonly createdAt: number;
}

export const TOAST_LIFETIME_MS = 1600;
/** Rival warning when the opponent launches a queen (flash styling + longer life). */
export const INCOMING_QUEEN_TOAST_MS = 3800;
const TOAST_MAX = 8;

let toastCounter = 0;
const newToastId = (): string => `t${++toastCounter}`;

let commandCounter = 0;
const newCommandId = (): string => `c${++commandCounter}`;

/**
 * High-level mode the app is currently in.
 * - `'menu'`: title screen; no game simulation.
 * - `'solo'`: local engine ticks the world; no network.
 * - `'lobby'`: connected (or connecting) to the server, browsing or waiting in
 *   a room. The game UI is hidden in favour of the {@link Lobby} screen.
 * - `'online'`: an authoritative match is in flight. `world` is replaced on
 *   every `SNAPSHOT` and the local tick is a no-op.
 */
export type AppMode = 'menu' | 'solo' | 'lobby' | 'online';

export type { AiDifficulty };
export { AI_DIFFICULTIES };

export interface RoomState {
  readonly code: string;
  readonly phase: GamePhase;
  readonly players: readonly PlayerSummary[];
  readonly selfId: string | null;
  readonly playerIds: readonly string[] | null;
  readonly result: { readonly winnerId: string | null; readonly reason: 'queen' | 'forfeit' } | null;
}

export interface NetState {
  readonly status: ConnectionStatus | 'idle';
  /** Last error message surfaced via `ERROR` server frame, or local connect failure. */
  readonly lastError: string | null;
}

interface GameStore {
  panel: PanelIndex;
  setPanel: (panel: PanelIndex) => void;

  // ---- navigation / multiplayer slice ----
  mode: AppMode;
  /** Selected on the title screen before {@link startSolo}. */
  soloDifficulty: AiDifficulty;
  setSoloDifficulty: (level: AiDifficulty) => void;
  net: NetState;
  room: RoomState | null;

  world: ClientWorld;
  /** Index into `world.opponents` for mini-map tabs and queen targeting. */
  selectedRivalIndex: number;
  setSelectedRivalIndex: (index: number) => void;
  /** Pick assault target inside the queen attack popup. */
  setQueenTargetRivalIndex: (index: number) => void;
  /** Advance rival mini-map tab without resetting the manual-pick cooldown. */
  cycleRivalTab: () => void;
  /** Timestamp of last manual rival tab pick (pauses auto-cycle). */
  rivalTabManualUntil: number;
  /**
   * In-progress swipe paths and invalid words kept after release. A valid
   * word is sent on pointer-up (`tryAutoSubmitLastCompletedDraft`); the last
   * entry is the path currently being extended during a drag.
   */
  wordDrafts: readonly (readonly Hex[])[];
  /** Set while the user is drag-moving a letter between storage and comb tiles. */
  letterDrag: LetterDrag | null;
  /** Hex (active or empty storage) currently hovered as a drop target during letter drag. */
  dropHover: Hex | null;
  /** Set while an auto word-submit is being applied (guards double-fire). */
  submitting: boolean;
  /** Last error from a refused command (cleared on next success). */
  lastError: string | null;
  /** Active hex-anchored popup messages. The renderer drops entries older than
   *  each toast's lifetime (see {@link Toast.lifetimeMs}). New entries are appended;
   *  overflow is dropped from the head so spam doesn't leak. */
  toasts: readonly Toast[];
  /**
   * Queen targeting mode. After {@link dispatchQueen} is called the player
   * chooses an {@link QueenAttackSide} on the expanded rival mini-board. After
   * {@link QUEEN_TARGETING_MS} elapses without a pick the queen auto-fires via
   * {@link pickQueenLandingHex}.
   */
  queenTargeting: {
    readonly startedAt: number;
    readonly deadline: number;
    /** Rival index in `world.opponents` chosen in the attack popup. */
    readonly targetRivalIndex: number;
  } | null;

  /** Title-screen preference: next solo match runs the guided tutorial. */
  tutorialEnabled: boolean;
  setTutorialEnabled: (on: boolean) => void;
  /** True while a tutorial-guided solo match is in progress. */
  tutorialActive: boolean;
  tutorialStep: TutorialStepId | null;
  /** When true, {@link tick} does not advance the simulation. */
  tutorialPaused: boolean;
  /** Set when resuming after {@link TutorialStepId} `3c-frontier-expand` to watch carpenters. */
  tutorialCarpenterWaitStartedAt: number | null;
  tutorialCarpenterSawBusy: boolean;
  advanceTutorial: () => void;

  /** Dev/testing overlay toggled with `` ` `` or `?debug=1`. Actions only apply in solo mode. */
  debugMode: boolean;
  toggleDebugMode: () => void;
  /** Spawn a queen that assaults the rival hive (`towardRival`) or your own hive (`towardSelf`) via engine dispatch. */
  debugSpawnQueen: (toward: 'towardRival' | 'towardSelf') => void;
  /** Add honey on the given side (clamped at zero). */
  debugAdjustHoney: (side: Side, delta: number) => void;
  /** Fill empty storage with one of each special tile kind (solo only). */
  debugGiveSpecialTiles: () => void;

  initSolo: (seed?: number) => void;
  /** Begin a local match from the title screen (applies {@link soloDifficulty}). */
  startSolo: (seed?: number) => void;
  /** Return to the title screen from solo or after leaving a room. */
  enterMenu: () => void;
  tick: (dt: number) => void;

  /**
   * Single entry point for every gameplay mutation. In solo it routes to the
   * local engine; in M5.2 the network mode swaps this for a wire-bound
   * sender so all the existing UI affordances keep working unchanged.
   */
  applyCommand: (cmd: GameCommand, side?: Side) => CommandResult;

  /** Hold-to-send: dispatch a single-trip worker to the given petal hex. */
  dispatchWorker: (h: Hex, side?: Side) => void;
  /** Hold-to-send: dispatch a single-trip carpenter to the given frontier hex. */
  dispatchCarpenter: (h: Hex, side?: Side) => void;
  /**
   * Begin a queen dispatch. Honey/allowance preconditions are checked here so
   * we don't enter targeting just to bounce off the engine later.
   * On success this enters {@link queenTargeting}; the actual queen is sent
   * via {@link confirmQueenAttackSide} (or auto-fired after the timer elapses).
   */
  dispatchQueen: (side?: Side) => void;
  /** Confirm the queen assault direction on the rival hive (outermost hex on that side). */
  confirmQueenAttackSide: (side: QueenAttackSide) => void;
  /** Abort an in-progress queen targeting (e.g. user clicked the spawn button again). */
  cancelQueenTargeting: () => void;
  /** Clear the most recent dispatch error (e.g. when the user tries again). */
  clearError: () => void;
  /** Add a contextual popup at (panel, hex). Used by UI predicates and by
   *  engine-action wrappers below to surface failures where the user clicked. */
  pushToast: (toast: {
    text: string;
    panel: BeePanel;
    hex: Hex;
    variant?: Toast['variant'];
    lifetimeMs?: number;
  }) => void;

  /** Letter movement: storage ↔ honeycomb, or reposition uncapped letters. */
  startLetterDrag: (fromHex: Hex) => void;
  setDropHover: (h: Hex | null) => void;
  commitLetterDrag: () => void;
  cancelLetterDrag: () => void;

  // Word draft: drag across letter/capped tiles. Multi-path supported.
  startDraft: (h: Hex) => void;
  extendDraft: (h: Hex) => void;
  endDraft: () => void;
  removeDraft: (index: number) => void;
  clearDraft: () => void;
  /** After a completed swipe, attempts dictionary + engine submit for the last path only. */
  tryAutoSubmitLastCompletedDraft: () => void;

  // ---- multiplayer actions ----
  /** Switch into lobby mode. No socket is opened until the player chooses to
   *  create or join a room — under the Cloudflare backend, the WS lifecycle is
   *  bound 1:1 to a specific room code, so there's no point opening one
   *  speculatively. Idempotent. */
  enterLobby: () => void;
  /** Leave lobby/online: close the socket, return to solo with a fresh world. */
  leaveLobby: () => void;
  /** Mint a new room code (HTTP `POST /api/rooms`), open a WS to that room,
   *  and send `HELLO` once the socket is up. */
  createRoom: (playerName: string) => Promise<void>;
  /** Open a WS to the given room code and send `HELLO`. The server will
   *  reject the upgrade with 404 if the code is unknown. */
  joinRoom: (roomCode: string, playerName: string) => void;
  /** Mark this player ready. */
  sendReady: () => void;
  /**
   * When the tab becomes visible again, reopen the room socket if we were in a
   * multiplayer session and the connection dropped (common when a mobile browser
   * suspends the tab). Safe to call repeatedly; no-ops if already connected.
   */
  tryReconnectRoom: () => void;
  /**
   * Test seam: install a fake {@link NetConnection} (and treat the store as
   * connected). Production code goes through {@link enterLobby}.
   */
  _setConnection: (conn: NetConnection | null) => void;
  /** Test seam: dispatch a server message as if it arrived on the wire. */
  _handleServerMessage: (msg: ServerMessage) => void;
}

let rng: () => number = makeRng(1);

const reseed = (seed: number) => {
  rng = makeRng(seed);
};

/**
 * Inflate a server `WorldSnapshot` into the local `World` shape the renderer
 * expects. AI cooldowns are zeroed — they only drive the solo dummy AI, which
 * never runs in online mode.
 */
const normalizePlayer = (p: PlayerState): PlayerState => ({
  ...p,
  bestWord: p.bestWord ?? '',
  bestWordScore: p.bestWordScore ?? 0,
});

const snapshotToWorld = (snap: WorldSnapshot): ClientWorld => {
  const playerIds = [snap.self.id, ...snap.opponents.map((o) => o.id)];
  const players: Record<string, PlayerState> = {
    [snap.self.id]: normalizePlayer(snap.self),
    ...Object.fromEntries(snap.opponents.map((o) => [o.id, normalizePlayer(o)])),
  };
  const base: World = {
    t: snap.t,
    phase: snap.phase,
    playerIds,
    players,
    activePlayerIds: playerIds.filter((id) => !snap.eliminatedPlayerIds.includes(id)),
    eliminatedPlayerIds: snap.eliminatedPlayerIds,
    winnerId: snap.winner === 'self' ? snap.self.id : null,
    playerCount: snap.playerCount,
    patches: snap.patches,
    patchCooldown: 0,
    aiWorkerCooldown: 0,
    aiPlaceCooldown: 0,
    aiPhantomCooldown: 0,
    aiCarpenterCooldown: 0,
    aiDifficulty: 'medium',
    aiActionDelay: 0,
    aiWorkerHoldHex: null,
    aiWorkerHoldElapsed: 0,
    log: snap.log,
  };
  return toClientWorld(base, snap.self.id, snap);
};

const tileAtSelf = (world: ClientWorld, h: Hex): TileSnapshot | undefined =>
  world.self.tiles.find((t) => hexEquals(t.hex, h));

const draftToWord = (world: ClientWorld, path: readonly Hex[]): string => {
  const resolved = resolveWordFromPath(path, world.self.tiles);
  return resolved?.word.toUpperCase() ?? '';
};

/** Held in module scope so tests can inject a fake via `_setConnection`. */
let conn: NetConnection | null = null;

/** Remembered when joining/creating a room so we can HELLO again after a drop. */
let multiplayerSession: { readonly roomCode: string; readonly playerName: string } | null = null;

/** How long the player has to pick a queen landing hex before auto-firing. */
export const QUEEN_TARGETING_MS = 5000;

/**
 * Timer handle for the queen-targeting auto-fire fallback. Held in module
 * scope (not in zustand state) because we never want React renders to depend
 * on the timer's identity — it's purely a scheduling artifact.
 */
let queenTargetingTimer: ReturnType<typeof setTimeout> | null = null;
const clearQueenTimer = () => {
  if (queenTargetingTimer !== null) {
    clearTimeout(queenTargetingTimer);
    queenTargetingTimer = null;
  }
};

export const useGameStore = create<GameStore>((set, get) => {
  const pushWordCapHoneyToastFromLog = (
    prevLog: World['log'],
    nextLog: World['log'],
    selfId: string,
  ): void => {
    drainWordCapHoneyToasts(prevLog, nextLog, selfId, ({ text, variant, lifetimeMs }) => {
      get().pushToast({
        text,
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant,
        lifetimeMs,
      });
    }, () => {
      get().pushToast({
        text: 'pollen bloom',
        panel: 'flowers',
        hex: { q: 0, r: 0 },
        variant: 'alert',
        lifetimeMs: 2800,
      });
    });
  };

  const wireRoomConnection = (roomCode: string, playerName: string) => {
    conn = openRoomConnection(roomCode.toUpperCase(), {
      onMessage: (msg) => get()._handleServerMessage(msg),
      onStatus: (status) => {
        set((s) => ({ net: { ...s.net, status } }));
        if (status === 'closed' || status === 'error') {
          conn = null;
        }
      },
      onOpen: () => conn?.send({ type: 'HELLO', playerName }),
    });
  };

  return {
  panel: 1,
  setPanel: (panel) => set({ panel }),
  selectedRivalIndex: 0,
  setSelectedRivalIndex: (index) =>
    set({
      selectedRivalIndex: index,
      rivalTabManualUntil: performance.now() + 6000,
    }),
  setQueenTargetRivalIndex: (index) =>
    set((s) => {
      if (!s.queenTargeting) return s;
      const rival = s.world.opponents[index];
      if (!rival || isRivalEliminated(s.world, rival.id)) return s;
      return { queenTargeting: { ...s.queenTargeting, targetRivalIndex: index } };
    }),
  cycleRivalTab: () =>
    set((s) => {
      const n = s.world.opponents.length;
      if (n <= 1) return s;
      return { selectedRivalIndex: (s.selectedRivalIndex + 1) % n };
    }),
  rivalTabManualUntil: 0,

  mode: 'menu',
  soloDifficulty: readTutorialPref() ? 'easy' : 'medium',
  setSoloDifficulty: (level) => {
    if (get().tutorialEnabled && level !== 'easy') return;
    set({ soloDifficulty: level });
  },
  tutorialEnabled: readTutorialPref(),
  setTutorialEnabled: (on) => {
    writeTutorialPref(on);
    set(on ? { tutorialEnabled: true, soloDifficulty: 'easy' } : { tutorialEnabled: false });
  },
  tutorialActive: false,
  tutorialStep: null,
  tutorialPaused: false,
  tutorialCarpenterWaitStartedAt: null,
  tutorialCarpenterSawBusy: false,
  net: { status: 'idle', lastError: null },
  room: null,

  world: wrapSoloWorld(buildInitialWorld(rng)),
  wordDrafts: [],
  letterDrag: null,
  dropHover: null,
  submitting: false,
  lastError: null,
  toasts: [],
  queenTargeting: null,

  debugMode: false,

  toggleDebugMode: () => set((s) => ({ debugMode: !s.debugMode })),

  debugSpawnQueen: (toward) => {
    if (!get().debugMode) return;
    if (get().mode !== 'solo') {
      get().pushToast({
        text: 'debug: solo mode only',
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'info',
      });
      return;
    }
    get().cancelQueenTargeting();
    const cost = BEE_STATS.queen.honeyCost;
    const side: Side = toward === 'towardRival' ? 'self' : 'opponent';
    set((s) => {
      const w = s.world;
      if (side === 'self') {
        const self = padTilesForQueenMin(w.self);
        return { world: { ...w, self: { ...self, honey: Math.max(self.honey, cost) } } };
      }
      const opp = padTilesForQueenMin(w.opponent);
      return { world: { ...w, opponent: { ...opp, honey: Math.max(opp.honey, cost) } } };
    });
    const r = get().applyCommand({ kind: 'dispatchQueen' }, side);
    if (!r.ok) {
      get().pushToast({
        text: `debug queen: ${r.reason}`,
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
    }
  },

  debugAdjustHoney: (side, delta) => {
    if (!get().debugMode) return;
    if (get().mode !== 'solo') return;
    set((s) => {
      const p = getPlayer(s.world, side);
      const nextHoney = Math.max(0, p.honey + delta);
      const base = setPlayerById(s.world, side, { ...p, honey: nextHoney });
      return { world: toClientWorld(base, 'self') };
    });
  },

  debugGiveSpecialTiles: () => {
    if (!get().debugMode) return;
    if (get().mode !== 'solo') {
      get().pushToast({
        text: 'debug: solo mode only',
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'info',
      });
      return;
    }
    const self = get().world.self;
    const emptySlots: TileSnapshot[] = [];
    for (const t of self.tiles) {
      if (t.state === 'storage' && !t.letter && !t.specialKind) {
        emptySlots.push(t);
      }
    }
    for (const t of self.tiles) {
      if (emptySlots.length >= SPECIAL_TILE_KINDS.length) break;
      if (t.state === 'active' && !t.letter && !t.specialKind) {
        emptySlots.push(t);
      }
    }
    if (emptySlots.length < SPECIAL_TILE_KINDS.length) {
      get().pushToast({
        text: `debug: need ${SPECIAL_TILE_KINDS.length} empty slots (${emptySlots.length} free)`,
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
      return;
    }
    const kindsByHex = new Map(
      SPECIAL_TILE_KINDS.map((kind, i) => [hexKey(emptySlots[i]!.hex), kind]),
    );
    const updatedTiles = self.tiles.map((t) => {
      const kind = kindsByHex.get(hexKey(t.hex));
      if (!kind) return t;
      return {
        ...t,
        letter: null,
        specialKind: kind,
        ...(kind === 'bomb' ? { bombOwnerId: self.id } : {}),
      };
    });
    const base = setPlayerById(get().world, 'self', { ...self, tiles: updatedTiles });
    set({ world: toClientWorld(base, 'self') });
    get().pushToast({
      text: 'debug: all special tiles in storage',
      panel: 'self-hive',
      hex: emptySlots[0]!.hex,
      variant: 'info',
    });
  },

  initSolo: (seed) => {
    reseed(seed ?? Date.now() & 0xffffffff);
    clearQueenTimer();
    const aiDifficulty = get().soloDifficulty;
    const withTutorial = get().tutorialEnabled;
    set({
      world: wrapSoloWorld(buildInitialWorld(rng, undefined, { aiDifficulty })),
      wordDrafts: [],
      letterDrag: null,
      dropHover: null,
      submitting: false,
      lastError: null,
      toasts: [],
      queenTargeting: null,
      panel: withTutorial ? 0 : 1,
      tutorialActive: withTutorial,
      tutorialStep: withTutorial ? '1a-hive' : null,
      tutorialPaused: withTutorial,
      tutorialCarpenterWaitStartedAt: null,
      tutorialCarpenterSawBusy: false,
    });
    resetWordCapHoneyToastSeen(get().world.log.map((e) => e.id));
  },

  startSolo: (seed) => {
    get().initSolo(seed);
    set({ mode: 'solo' });
  },

  advanceTutorial: () => {
    const step = get().tutorialStep;
    if (!get().tutorialActive || !step) return;

    switch (step) {
      case '1a-hive':
        set({ tutorialStep: '1b-flowers', tutorialPaused: true, panel: 1 });
        break;
      case '1b-flowers':
        set({ tutorialStep: 'playing-collect-letter', tutorialPaused: false, panel: 1 });
        break;
      case '2a-storage':
        set({ tutorialStep: 'playing-place-bee-letters', tutorialPaused: false, panel: 0 });
        break;
      case '3a-draft':
        set({ tutorialStep: 'playing-spell-bee', tutorialPaused: false, panel: 0 });
        break;
      case '3b-pollen-bloom':
        set({ tutorialStep: '3c-frontier-expand', tutorialPaused: true, panel: 0 });
        break;
      case '3c-frontier-expand':
        set({
          tutorialStep: 'waiting-carpenter-expand',
          tutorialPaused: false,
          panel: 0,
          tutorialCarpenterWaitStartedAt: performance.now(),
          tutorialCarpenterSawBusy: false,
        });
        break;
      case '3d-reuse':
        set({ tutorialStep: 'playing-spell-reuse', tutorialPaused: false, panel: 0 });
        break;
      case '3e-navigation':
        set({ tutorialStep: 'waiting-queen-ready', tutorialPaused: false, panel: 0 });
        break;
      case '4a-queen':
        set({
          tutorialActive: false,
          tutorialStep: 'complete',
          tutorialPaused: false,
        });
        break;
      default:
        break;
    }
  },

  enterMenu: () => {
    multiplayerSession = null;
    if (conn) {
      conn.send({ type: 'LEAVE' });
      conn.close();
      conn = null;
    }
    clearQueenTimer();
    set({
      mode: 'menu',
      net: { status: 'idle', lastError: null },
      room: null,
      queenTargeting: null,
      wordDrafts: [],
      letterDrag: null,
      dropHover: null,
      lastError: null,
      toasts: [],
      tutorialActive: false,
      tutorialStep: null,
      tutorialPaused: false,
      tutorialCarpenterWaitStartedAt: null,
      tutorialCarpenterSawBusy: false,
    });
  },

  tick: (dt) => {
    const prevLog = get().world.log;
    const selfId = get().world.self.id;
    set((s) => {
      if (s.tutorialPaused) return s;
      if (s.mode === 'menu' || s.mode === 'lobby') return s;
      if (s.mode === 'online') {
        // Run the pure engine simulation locally for smooth bee animations
        // and honey trickle between snapshots — every SNAPSHOT replaces
        // `world` with the authoritative state, so any local drift is
        // continuously corrected. `clientPrediction: true` skips the RNG-
        // driven flower-patch step (the server owns spawn positions; running
        // it locally with a desynced seed makes flowers visibly jitter as
        // the snapshot snaps them back). The solo AI is also skipped: the
        // server is the only thing allowed to dispatch the opponent.
        return {
          world: toClientWorld(
            tickWorld(s.world, dt, rng, { clientPrediction: true }),
            s.world.self.id,
          ),
        };
      }
      return { world: wrapSoloWorld(tickSolo(s.world, dt, rng)) };
    });
    const after = get();
    if (after.tutorialActive && !after.tutorialPaused) {
      const { tutorialStep, world } = after;
      if (
        tutorialStep === 'waiting-worker-return' &&
        !selfHasWorkerInFlight(world) &&
        storageHasLetter(world)
      ) {
        set({
          world: injectStorageLetters(world, ['B', 'E', 'E']),
          tutorialStep: '2a-storage',
          tutorialPaused: true,
          panel: 0,
        });
      } else if (
        tutorialStep === 'waiting-bee-cap' &&
        !selfHasCappingBee(world) &&
        hasBeeWordCappedOnComb(world)
      ) {
        set({ tutorialStep: '3b-pollen-bloom', tutorialPaused: true, panel: 0 });
      } else if (tutorialStep === 'waiting-carpenter-expand') {
        const startedAt = after.tutorialCarpenterWaitStartedAt ?? performance.now();
        const elapsed = performance.now() - startedAt;
        if (selfHasCarpenterBusy(world)) {
          if (!after.tutorialCarpenterSawBusy) {
            set({ tutorialCarpenterSawBusy: true });
          }
        } else if (
          after.tutorialCarpenterSawBusy ||
          elapsed >= TUTORIAL_CARPENTER_WAIT_FALLBACK_MS
        ) {
          set({
            world: injectStorageLetters(world, ['S']),
            tutorialStep: '3d-reuse',
            tutorialPaused: true,
            panel: 0,
            tutorialCarpenterWaitStartedAt: null,
            tutorialCarpenterSawBusy: false,
          });
        }
      } else if (
        tutorialStep === 'waiting-bees-cap' &&
        !selfHasCappingBee(world) &&
        hasBeesWordCappedOnComb(world)
      ) {
        set({ tutorialStep: '3e-navigation', tutorialPaused: true, panel: 0 });
      } else if (tutorialStep === 'waiting-queen-ready' && canSpawnQueenNow(world)) {
        set({ tutorialStep: '4a-queen', tutorialPaused: true, panel: 0 });
      }
    }
    pushWordCapHoneyToastFromLog(prevLog, get().world.log, selfId);
  },

  applyCommand: (cmd, side = 'self') => {
    const prevLog = get().world.log;
    const selfId = get().world.self.id;
    const actorId =
      side === 'self'
        ? selfId
        : side === 'opponent'
          ? (get().world.opponents[0]?.id ?? 'opponent')
          : side;
    const r = engineApplyCommand(get().world, actorId, cmd);
    if (r.ok) {
      if (actorId === selfId) playCommandSfx(cmd);
      set({ world: toClientWorld(r.world, selfId), lastError: null });
      if (actorId === selfId) {
        pushWordCapHoneyToastFromLog(prevLog, get().world.log, selfId);
      }
    } else {
      set({ lastError: r.reason });
    }
    if (r.ok && actorId === selfId && get().mode === 'online' && conn) {
      conn.send({ type: 'COMMAND', commandId: newCommandId(), cmd });
    }
    return r;
  },

  dispatchWorker: (h, side = 'self') => {
    const r = get().applyCommand({ kind: 'dispatchWorker', target: h }, side);
    // Only surface failures for local actions — the AI dispatches with
    // `side === 'opponent'` and we don't want phantom popups from its misses.
    if (!r.ok && side === 'self') {
      get().pushToast({ text: r.reason, panel: 'flowers', hex: h, variant: 'error' });
      return;
    }
    if (
      r.ok &&
      side === 'self' &&
      get().tutorialActive &&
      get().tutorialStep === 'playing-collect-letter'
    ) {
      set({ tutorialStep: 'waiting-worker-return' });
    }
  },

  dispatchCarpenter: (h, side = 'self') => {
    const r = get().applyCommand({ kind: 'dispatchCarpenter', target: h }, side);
    if (!r.ok && side === 'self') {
      get().pushToast({ text: r.reason, panel: 'self-hive', hex: h, variant: 'error' });
    }
  },

  dispatchQueen: (side = 'self') => {
    // Only the local player goes through targeting; opponent dispatches
    // (AI / replays) skip straight to the engine with no target so the
    // engine auto-picks via `pickQueenLandingHex`. We don't surface failures
    // for the opponent — phantom toasts during AI misses are noise.
    if (side !== 'self') {
      get().applyCommand({ kind: 'dispatchQueen' }, side);
      return;
    }
    // Pre-validate so we don't enter targeting just to bounce off the engine
    // 5 seconds later.
    const s = get();
    const player = s.world.self;
    const cost = BEE_STATS.queen.honeyCost;
    if (player.honey < cost) {
      s.pushToast({ text: 'not enough honey', panel: 'self-hive', hex: { q: 0, r: 0 }, variant: 'error' });
      return;
    }
    if (player.tiles.length < QUEEN_MIN_OWNED_HEXES) {
      s.pushToast({
        text: `queen unlocks at ${QUEEN_MIN_OWNED_HEXES} hive hexes (${player.tiles.length} now)`,
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
      return;
    }
    if (activeQueenCountFor(player) >= queenAllowanceFor(player)) {
      s.pushToast({
        text: 'queen allowance reached',
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
      return;
    }
    // Already targeting? Treat the second click as a cancel so the spawn
    // button is its own "back out" affordance.
    if (s.queenTargeting) {
      get().cancelQueenTargeting();
      return;
    }
    clearQueenTimer();
    const startedAt = performance.now();
    const deadline = startedAt + QUEEN_TARGETING_MS;
    const world = s.world;
    const sel = world.opponents[s.selectedRivalIndex];
    const targetRivalIndex =
      sel && !isRivalEliminated(world, sel.id)
        ? s.selectedRivalIndex
        : firstActiveRivalIndex(world);
    set({ queenTargeting: { startedAt, deadline, targetRivalIndex } });
    queenTargetingTimer = setTimeout(() => {
      queenTargetingTimer = null;
      // If targeting was cancelled or already confirmed, do nothing.
      const qt = get().queenTargeting;
      if (!qt) return;
      set({ queenTargeting: null });
      const rival = queenTargetRival(get().world, qt.targetRivalIndex);
      if (!rival) return;
      const r = get().applyCommand(
        { kind: 'dispatchQueen', targetPlayerId: rival.id },
        'self',
      );
      if (!r.ok) {
        get().pushToast({
          text: r.reason,
          panel: 'self-hive',
          hex: { q: 0, r: 0 },
          variant: 'error',
        });
      }
    }, QUEEN_TARGETING_MS);
  },

  confirmQueenAttackSide: (attackSide) => {
    const s = get();
    const qt = s.queenTargeting;
    if (!qt) return;
    const rival = queenTargetRival(s.world, qt.targetRivalIndex);
    if (!rival) {
      s.pushToast({
        text: 'target eliminated',
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
      return;
    }
    clearQueenTimer();
    set({ queenTargeting: null });
    const r = get().applyCommand(
      { kind: 'dispatchQueen', attackSide, targetPlayerId: rival.id },
      'self',
    );
    if (!r.ok) {
      get().pushToast({
        text: r.reason,
        panel: 'self-hive',
        hex: { q: 0, r: 0 },
        variant: 'error',
      });
    }
  },

  cancelQueenTargeting: () => {
    clearQueenTimer();
    if (get().queenTargeting) set({ queenTargeting: null });
  },

  clearError: () => set({ lastError: null }),

  pushToast: ({ text, panel, hex, variant = 'error', lifetimeMs }) => {
    set((s) => {
      const now = performance.now();
      const live = s.toasts.filter(
        (t) => now - t.createdAt < (t.lifetimeMs ?? TOAST_LIFETIME_MS),
      );
      const next: Toast = {
        id: newToastId(),
        text,
        panel,
        hex,
        variant,
        createdAt: now,
        ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
      };
      // Cap the queue from the head so a burst of holds doesn't pile up off-screen.
      const trimmed = live.length >= TOAST_MAX ? live.slice(live.length - TOAST_MAX + 1) : live;
      return { toasts: [...trimmed, next] };
    });
  },

  startLetterDrag: (fromHex) => {
    set((s) => {
      const tile = tileAtSelf(s.world, fromHex);
      if (!tile?.letter && !tile?.specialKind) return s;
      if (tile.state === 'capped') return s;
      if (tile.state !== 'storage' && tile.state !== 'active' && tile.state !== 'letter') {
        return s;
      }
      return {
        letterDrag: {
          fromHex,
          ...(tile.letter ? { letter: tile.letter } : {}),
          ...(tile.specialKind ? { specialKind: tile.specialKind } : {}),
        },
        dropHover: null,
        lastError: null,
      };
    });
  },

  setDropHover: (h) => {
    set((s) => {
      if (!s.letterDrag) {
        return s.dropHover === null ? s : { dropHover: null };
      }
      if (h === null) return { dropHover: null };
      const tile = tileAtSelf(s.world, h);
      const okSlot =
        !!tile &&
        !tile.letter &&
        !tile.specialKind &&
        (tile.state === 'active' || tile.state === 'storage');
      if (!okSlot) return { dropHover: null };
      return { dropHover: h };
    });
  },

  commitLetterDrag: () => {
    const s = get();
    const drag = s.letterDrag;
    const target = s.dropHover;
    if (!drag) return;
    if (!target) {
      set({ letterDrag: null, dropHover: null });
      return;
    }
    const r = get().applyCommand(
      { kind: 'placeLetter', from: drag.fromHex, to: target },
      'self',
    );
    if (!r.ok) {
      set({ letterDrag: null, dropHover: null });
      get().pushToast({ text: r.reason, panel: 'self-hive', hex: target, variant: 'error' });
      return;
    }
    set({ letterDrag: null, dropHover: null });
    const after = get();
    if (
      after.tutorialActive &&
      after.tutorialStep === 'playing-place-bee-letters' &&
      hasBeeLettersOnComb(after.world)
    ) {
      set({ tutorialStep: '3a-draft', tutorialPaused: true, panel: 0 });
    }
  },

  cancelLetterDrag: () => {
    const s = get();
    if (s.letterDrag === null && s.dropHover === null) return;
    set({ letterDrag: null, dropHover: null });
  },

  startDraft: (h) => {
    const s = get();
    const tile = tileAtSelf(s.world, h);
    if (!tileHasDraftableLetter(tile)) return;
    set({
      wordDrafts: [...s.wordDrafts, [h]],
      letterDrag: null,
      dropHover: null,
      lastError: null,
    });
  },

  extendDraft: (h) => {
    set((s) => {
      const drafts = s.wordDrafts;
      if (drafts.length === 0) return s;
      const idx = drafts.length - 1;
      const cur = drafts[idx]!;
      if (cur.length === 0) return s;
      // Backtrack: dragging onto the second-to-last tile shrinks the draft.
      if (cur.length >= 2 && hexEquals(cur[cur.length - 2]!, h)) {
        const next = cur.slice(0, -1);
        return {
          wordDrafts: drafts.slice(0, idx).concat([next]),
        };
      }
      const last = cur[cur.length - 1]!;
      if (hexEquals(last, h)) return s;
      if (cur.some((d) => hexEquals(d, h))) return s;
      if (!isAdjacent(last, h)) return s;
      const tile = tileAtSelf(s.world, h);
      if (!tileHasDraftableLetter(tile)) return s;
      return {
        wordDrafts: drafts.slice(0, idx).concat([[...cur, h]]),
      };
    });
  },

  endDraft: () => {
    const s = get();
    const drafts = s.wordDrafts;
    if (drafts.length === 0) return;
    const last = drafts[drafts.length - 1]!;
    if (last.length < 2) {
      // Drop incomplete drafts (single-tap or aborted drag).
      set({ wordDrafts: drafts.slice(0, -1) });
      return;
    }
    // Defer one tick so multi-path tests (and any same-frame draft edits) see stable `wordDrafts`
    // before we read the last path for submit.
    queueMicrotask(() => {
      get().tryAutoSubmitLastCompletedDraft();
    });
  },

  tryAutoSubmitLastCompletedDraft: () => {
    const s0 = get();
    const drafts = s0.wordDrafts;
    if (drafts.length === 0) return;
    const path = drafts[drafts.length - 1]!;
    if (path.length < 2) return;
    if (s0.submitting) return;

    const word = draftToWord(s0.world, path);
    const anchor = path[0]!;
    const toastAt = (text: string) =>
      get().pushToast({ text, panel: 'self-hive', hex: anchor, variant: 'error' });

    if (wordStatus(word) !== 'valid') {
      toastAt(`not in dictionary: ${word || '?'}`);
      return;
    }

    set({ submitting: true, lastError: null });
    const pathUsedCapped = path.some((h) => {
      const tile = tileAtSelf(s0.world, h);
      return tile?.state === 'capped';
    });
    try {
      const r = get().applyCommand({ kind: 'submitWords', paths: [path] }, 'self');
      if (!r.ok) {
        set({ submitting: false });
        toastAt(r.reason);
        return;
      }
      const submittedWord = word;
      if (get().debugMode) {
        console.log('[debug] word spelled:', submittedWord);
      }
      set((s) => {
        let tutorialStep = s.tutorialStep;
        let tutorialPaused = s.tutorialPaused;
        let world = s.world;
        if (s.tutorialActive && tutorialStep === 'playing-spell-bee' && submittedWord === 'BEE') {
          tutorialStep = 'waiting-bee-cap';
          tutorialPaused = false;
        } else if (
          s.tutorialActive &&
          tutorialStep === 'playing-spell-reuse' &&
          pathUsedCapped &&
          submittedWord === 'BEES'
        ) {
          tutorialStep = 'waiting-bees-cap';
          tutorialPaused = false;
        }
        return {
          world,
          wordDrafts: s.wordDrafts.slice(0, -1),
          submitting: false,
          lastError: null,
          tutorialStep,
          tutorialPaused,
        };
      });
    } catch (err) {
      const msg = `submit failed: ${err instanceof Error ? err.message : String(err)}`;
      set({ submitting: false, lastError: msg });
      toastAt(msg);
    }
  },

  removeDraft: (index) => {
    set((s) => ({
      wordDrafts: s.wordDrafts.filter((_, i) => i !== index),
      lastError: null,
    }));
  },

  clearDraft: () => set({ wordDrafts: [], lastError: null }),

  // ---- multiplayer actions ----

  enterLobby: () => {
    set((s) => {
      if (s.mode !== 'solo' && s.mode !== 'menu') return s;
      return {
        mode: 'lobby',
        net: { status: 'idle', lastError: null },
        room: null,
      };
    });
  },

  leaveLobby: () => {
    get().enterMenu();
  },

  createRoom: async (playerName) => {
    if (conn) return;
    set((s) => ({ net: { ...s.net, status: 'connecting', lastError: null } }));
    let code: string;
    try {
      code = await createRoomCode();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create failed';
      set({ net: { status: 'error', lastError: msg } });
      return;
    }
    // Stash the code now so the lobby UI can render it before ROOM_STATE
    // arrives. The server's ROOM_STATE will overwrite this with the same value.
    set((s) => ({
      room: {
        code,
        phase: 'lobby',
        players: [],
        selfId: s.room?.selfId ?? null,
        playerIds: s.room?.playerIds ?? null,
        result: null,
      },
    }));
    multiplayerSession = { roomCode: code.toUpperCase(), playerName };
    wireRoomConnection(code, playerName);
  },

  joinRoom: (roomCode, playerName) => {
    if (conn) return;
    multiplayerSession = { roomCode: roomCode.toUpperCase(), playerName };
    set((s) => ({ net: { ...s.net, status: 'connecting', lastError: null } }));
    wireRoomConnection(roomCode, playerName);
  },

  tryReconnectRoom: () => {
    const { mode, net } = get();
    if (mode !== 'lobby' && mode !== 'online') return;
    if (!multiplayerSession) return;
    if (net.status === 'open' || net.status === 'connecting') return;
    conn = null;
    set((s) => ({ net: { ...s.net, status: 'connecting', lastError: null } }));
    wireRoomConnection(multiplayerSession.roomCode, multiplayerSession.playerName);
  },

  sendReady: () => {
    if (!conn) return;
    conn.send({ type: 'READY' });
  },

  _setConnection: (next) => {
    conn = next;
    if (!next) multiplayerSession = null;
    set((s) => ({
      mode: next ? 'lobby' : s.mode === 'online' ? 'menu' : s.mode,
      net: next
        ? { status: 'open', lastError: null }
        : { status: 'idle', lastError: null },
    }));
  },

  _handleServerMessage: (msg) => {
    switch (msg.type) {
      case 'ROOM_STATE': {
        set((s) => ({
          room: {
            code: msg.roomCode,
            phase: msg.phase,
            players: msg.players,
            selfId: s.room?.selfId ?? null,
            playerIds: s.room?.playerIds ?? null,
            result: s.room?.result ?? null,
          },
        }));
        break;
      }
      case 'GAME_START': {
        set((s) => ({
          mode: 'online',
          room: s.room
            ? {
                ...s.room,
                selfId: msg.selfId,
                playerIds: msg.playerIds,
                phase: 'playing',
                result: null,
              }
            : {
                code: '',
                phase: 'playing',
                players: [],
                selfId: msg.selfId,
                playerIds: msg.playerIds,
                result: null,
              },
          // Clear any stale UI from the solo session before snapshots land.
          wordDrafts: [],
          letterDrag: null,
          dropHover: null,
          submitting: false,
          lastError: null,
          toasts: [],
        }));
        break;
      }
      case 'SNAPSHOT': {
        const prevLog = get().world.log;
        const selfId = get().world.self.id;
        set({ world: snapshotToWorld(msg.world) });
        pushWordCapHoneyToastFromLog(prevLog, get().world.log, selfId);
        resetWordCapHoneyToastSeen(get().world.log.map((e) => e.id));
        break;
      }
      case 'COMMAND_RESULT': {
        if (!msg.ok && msg.reason) {
          get().pushToast({
            text: msg.reason,
            panel: 'self-hive',
            hex: { q: 0, r: 0 },
            variant: 'error',
          });
        }
        break;
      }
      case 'WORD_RESULT': {
        const invalid = msg.words.filter((w) => !w.valid);
        if (invalid.length > 0) {
          const text = `skipped: ${invalid.map((w) => w.letters.join('')).join(', ')}`;
          get().pushToast({
            text,
            panel: 'self-hive',
            hex: { q: 0, r: 0 },
            variant: 'error',
          });
        }
        break;
      }
      case 'GAME_OVER': {
        clearQueenTimer();
        set((s) => ({
          queenTargeting: null,
          room: s.room
            ? {
                ...s.room,
                phase: 'over',
                result: { winnerId: msg.winnerId, reason: msg.reason },
              }
            : s.room,
        }));
        break;
      }
      case 'ERROR': {
        set((s) => ({
          net: { ...s.net, lastError: msg.message },
        }));
        // Errors that imply the room is unjoinable bounce us back to the
        // create/join screen so the user can try again.
        if (msg.code === 'NO_ROOM' || msg.code === 'ROOM_FULL') {
          multiplayerSession = null;
          set({ room: null });
        }
        break;
      }
    }
  },
};
});

let multiplayerResumeHandlersInstalled = false;
function installMultiplayerResumeHandlers(): void {
  if (multiplayerResumeHandlersInstalled || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  multiplayerResumeHandlersInstalled = true;

  const resume = (): void => {
    queueMicrotask(() => {
      useGameStore.getState().tryReconnectRoom();
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
  window.addEventListener('pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) resume();
  });
}

installMultiplayerResumeHandlers();

export const draftKeySet = (drafts: readonly (readonly Hex[])[]): ReadonlyMap<string, number> => {
  const m = new Map<string, number>();
  drafts.forEach((path, idx) => {
    for (const h of path) m.set(hexKey(h), idx);
  });
  return m;
};
