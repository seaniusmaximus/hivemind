import { create } from 'zustand';
import {
  activeQueenCountFor,
  applyCommand as engineApplyCommand,
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
  buildInitialWorld,
  frontierFor,
  hexEquals,
  hexKey,
  isAdjacent,
  makeRng,
  queenAllowanceFor,
  tickSolo,
  tickWorld,
  tileHasDraftableLetter,
  type BeePanel,
  type CommandResult,
  type GameCommand,
  type GamePhase,
  type Hex,
  type Letter,
  type PlayerSummary,
  type QueenAttackSide,
  type ServerMessage,
  type Side,
  type TileSnapshot,
  type World,
  type WorldSnapshot,
} from '@hivemind/shared';
import { playCommandSfx } from '../game/audio/sfx.js';
import { resetWordCapHoneyToastSeen } from '../game/wordCapHoneyToastSeen.js';
import { wordStatus } from '../game/dictionary.js';
import {
  createRoomCode,
  openRoomConnection,
  type ConnectionStatus,
  type NetConnection,
} from '../game/net/connection.js';

const padTilesForQueenMin = (player: World['self']): World['self'] => {
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

export type PanelIndex = 0 | 1 | 2;

export interface LetterDrag {
  readonly fromHex: Hex;
  readonly letter: Letter;
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
 * - `'solo'`: local engine ticks the world; no network.
 * - `'lobby'`: connected (or connecting) to the server, browsing or waiting in
 *   a room. The game UI is hidden in favour of the {@link Lobby} screen.
 * - `'online'`: an authoritative match is in flight. `world` is replaced on
 *   every `SNAPSHOT` and the local tick is a no-op.
 */
export type AppMode = 'solo' | 'lobby' | 'online';

export interface RoomState {
  readonly code: string;
  readonly phase: GamePhase;
  readonly players: readonly PlayerSummary[];
  /** Set after `GAME_START` arrives. Identifies which player slot is us. */
  readonly selfId: string | null;
  readonly opponentId: string | null;
  /** Filled when the server emits `GAME_OVER`. The renderer surfaces this
   *  as a result overlay; the user clicks through to leave the room. */
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

  // ---- multiplayer slice ----
  mode: AppMode;
  net: NetState;
  room: RoomState | null;

  world: World;
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
  queenTargeting: { readonly startedAt: number; readonly deadline: number } | null;

  /** Dev/testing overlay toggled with `` ` `` or `?debug=1`. Actions only apply in solo mode. */
  debugMode: boolean;
  toggleDebugMode: () => void;
  /** Spawn a queen that assaults the rival hive (`towardRival`) or your own hive (`towardSelf`) via engine dispatch. */
  debugSpawnQueen: (toward: 'towardRival' | 'towardSelf') => void;
  /** Add honey on the given side (clamped at zero). */
  debugAdjustHoney: (side: Side, delta: number) => void;

  initSolo: (seed?: number) => void;
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
const snapshotToWorld = (snap: WorldSnapshot): World => ({
  t: snap.t,
  phase: snap.phase,
  self: snap.self,
  opponent: snap.opponent,
  patches: snap.patches,
  patchCooldown: 0,
  aiWorkerCooldown: 0,
  aiPlaceCooldown: 0,
  aiPhantomCooldown: 0,
  aiCarpenterCooldown: 0,
  winner: snap.winner,
  log: snap.log,
});

const tileAt = (world: World, side: Side, h: Hex): TileSnapshot | undefined =>
  world[side].tiles.find((t) => hexEquals(t.hex, h));

const draftToWord = (world: World, side: Side, path: readonly Hex[]): string =>
  path
    .map((h) => tileAt(world, side, h)?.letter ?? '')
    .join('')
    .toUpperCase();

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

  mode: 'solo',
  net: { status: 'idle', lastError: null },
  room: null,

  world: buildInitialWorld(rng),
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
      const p = s.world[side];
      const nextHoney = Math.max(0, p.honey + delta);
      return {
        world: {
          ...s.world,
          [side]: { ...p, honey: nextHoney },
        },
      };
    });
  },

  initSolo: (seed) => {
    reseed(seed ?? Date.now() & 0xffffffff);
    clearQueenTimer();
    set({
      world: buildInitialWorld(rng),
      wordDrafts: [],
      letterDrag: null,
      dropHover: null,
      submitting: false,
      lastError: null,
      toasts: [],
      queenTargeting: null,
      panel: 1,
    });
    resetWordCapHoneyToastSeen(get().world.log.map((e) => e.id));
  },

  tick: (dt) => {
    set((s) => {
      if (s.mode === 'online') {
        // Run the pure engine simulation locally for smooth bee animations
        // and honey trickle between snapshots — every SNAPSHOT replaces
        // `world` with the authoritative state, so any local drift is
        // continuously corrected. `clientPrediction: true` skips the RNG-
        // driven flower-patch step (the server owns spawn positions; running
        // it locally with a desynced seed makes flowers visibly jitter as
        // the snapshot snaps them back). The solo AI is also skipped: the
        // server is the only thing allowed to dispatch the opponent.
        return { world: tickWorld(s.world, dt, rng, { clientPrediction: true }) };
      }
      return { world: tickSolo(s.world, dt, rng) };
    });
  },

  applyCommand: (cmd, side = 'self') => {
    // Always apply locally first — both for solo and as client-prediction in
    // online mode. The next SNAPSHOT reconciles authoritative state.
    const r = engineApplyCommand(get().world, side, cmd);
    if (r.ok) {
      if (side === 'self') playCommandSfx(cmd);
      set({ world: r.world, lastError: null });
    } else {
      set({ lastError: r.reason });
    }
    // Only forward self-side commands the local engine accepted; opponents
    // never originate commands from this client, and obvious local failures
    // would just be re-rejected server-side.
    if (r.ok && side === 'self' && get().mode === 'online' && conn) {
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
    set({ queenTargeting: { startedAt, deadline } });
    queenTargetingTimer = setTimeout(() => {
      queenTargetingTimer = null;
      // If targeting was cancelled or already confirmed, do nothing.
      if (!get().queenTargeting) return;
      set({ queenTargeting: null });
      const r = get().applyCommand({ kind: 'dispatchQueen' }, 'self');
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
    if (!s.queenTargeting) return;
    clearQueenTimer();
    set({ queenTargeting: null });
    const r = get().applyCommand({ kind: 'dispatchQueen', attackSide }, 'self');
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
      const tile = tileAt(s.world, 'self', fromHex);
      if (!tile?.letter) return s;
      if (tile.state === 'capped') return s;
      if (tile.state !== 'storage' && tile.state !== 'active' && tile.state !== 'letter') {
        return s;
      }
      return {
        letterDrag: { fromHex, letter: tile.letter },
        dropHover: null,
        lastError: null,
      };
    });
  },

  setDropHover: (h) => {
    set((s) => {
      if (!s.letterDrag) return s;
      if (h === null) return { dropHover: null };
      const tile = tileAt(s.world, 'self', h);
      const okSlot =
        !!tile &&
        !tile.letter &&
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
  },

  cancelLetterDrag: () => set({ letterDrag: null, dropHover: null }),

  startDraft: (h) => {
    const s = get();
    const tile = tileAt(s.world, 'self', h);
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
      const tile = tileAt(s.world, 'self', h);
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

    const word = draftToWord(s0.world, 'self', path);
    const anchor = path[0]!;
    const toastAt = (text: string) =>
      get().pushToast({ text, panel: 'self-hive', hex: anchor, variant: 'error' });

    if (wordStatus(word) !== 'valid') {
      toastAt(`not in dictionary: ${word || '?'}`);
      return;
    }

    set({ submitting: true, lastError: null });
    try {
      const r = get().applyCommand({ kind: 'submitWords', paths: [path] }, 'self');
      if (!r.ok) {
        set({ submitting: false });
        toastAt(r.reason);
        return;
      }
      set((s) => ({
        wordDrafts: s.wordDrafts.slice(0, -1),
        submitting: false,
        lastError: null,
      }));
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
      // Don't clobber an active connection. If we're already in lobby/online,
      // re-entering is a no-op.
      if (s.mode !== 'solo') return s;
      return {
        mode: 'lobby',
        net: { status: 'idle', lastError: null },
        room: null,
      };
    });
  },

  leaveLobby: () => {
    multiplayerSession = null;
    if (conn) {
      // Best-effort polite leave — the server's room teardown handles it
      // even if the frame doesn't make it out.
      conn.send({ type: 'LEAVE' });
      conn.close();
      conn = null;
    }
    clearQueenTimer();
    set({
      mode: 'solo',
      net: { status: 'idle', lastError: null },
      room: null,
      queenTargeting: null,
    });
    get().initSolo();
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
        opponentId: s.room?.opponentId ?? null,
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
    set({
      mode: next ? 'lobby' : 'solo',
      net: next
        ? { status: 'open', lastError: null }
        : { status: 'idle', lastError: null },
    });
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
            opponentId: s.room?.opponentId ?? null,
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
                opponentId: msg.opponentId,
                phase: 'playing',
                result: null,
              }
            : {
                code: '',
                phase: 'playing',
                players: [],
                selfId: msg.selfId,
                opponentId: msg.opponentId,
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
        set({ world: snapshotToWorld(msg.world) });
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
