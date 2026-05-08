import { create } from 'zustand';
import {
  applyCommand as engineApplyCommand,
  buildInitialWorld,
  hexEquals,
  hexKey,
  isAdjacent,
  makeRng,
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
  type ServerMessage,
  type Side,
  type TileSnapshot,
  type World,
  type WorldSnapshot,
} from '@hivemind/shared';
import { validateWord, wordStatus } from '../game/dictionary.js';
import {
  createRoomCode,
  openRoomConnection,
  type ConnectionStatus,
  type NetConnection,
} from '../game/net/connection.js';

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
  readonly variant: 'error' | 'info';
  /** `performance.now()` at creation; used to drive rise + fade animations. */
  readonly createdAt: number;
}

export const TOAST_LIFETIME_MS = 1600;
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
   * Paths the player has drafted for the next submission. Each path becomes
   * one capped word when the drone is dispatched. The last entry is the path
   * currently being extended by the active drag (if any).
   */
  wordDrafts: readonly (readonly Hex[])[];
  /** Set while the user is drag-moving a letter between storage and comb tiles. */
  letterDrag: LetterDrag | null;
  /** Hex (active or empty storage) currently hovered as a drop target during letter drag. */
  dropHover: Hex | null;
  /** Async submit in progress (awaiting dictionary). */
  submitting: boolean;
  /** Last error from a refused command (cleared on next success). */
  lastError: string | null;
  /** Active hex-anchored popup messages. The renderer drops entries older than
   *  `TOAST_LIFETIME_MS`. New entries are appended; overflow is dropped from
   *  the head so spam doesn't leak. */
  toasts: readonly Toast[];

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
  dispatchQueen: (side?: Side) => void;
  /** Clear the most recent dispatch error (e.g. when the user tries again). */
  clearError: () => void;
  /** Add a contextual popup at (panel, hex). Used by UI predicates and by
   *  engine-action wrappers below to surface failures where the user clicked. */
  pushToast: (toast: { text: string; panel: BeePanel; hex: Hex; variant?: Toast['variant'] }) => void;

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
  submitDraft: () => Promise<void>;

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

export const useGameStore = create<GameStore>((set, get) => ({
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

  initSolo: (seed) => {
    reseed(seed ?? Date.now() & 0xffffffff);
    set({
      world: buildInitialWorld(rng),
      wordDrafts: [],
      letterDrag: null,
      dropHover: null,
      submitting: false,
      lastError: null,
      toasts: [],
      panel: 1,
    });
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
    const r = get().applyCommand({ kind: 'dispatchQueen' }, side);
    if (!r.ok && side === 'self') {
      get().pushToast({ text: r.reason, panel: 'self-hive', hex: { q: 0, r: 0 }, variant: 'error' });
    }
  },

  clearError: () => set({ lastError: null }),

  pushToast: ({ text, panel, hex, variant = 'error' }) => {
    set((s) => {
      const now = performance.now();
      const live = s.toasts.filter((t) => now - t.createdAt < TOAST_LIFETIME_MS);
      const next: Toast = { id: newToastId(), text, panel, hex, variant, createdAt: now };
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
    // Kick off validation in the background; status is read via wordStatus().
    const word = draftToWord(s.world, 'self', last);
    if (word.length >= 2 && wordStatus(word) === 'unknown') {
      void validateWord(word);
    }
  },

  removeDraft: (index) => {
    set((s) => ({
      wordDrafts: s.wordDrafts.filter((_, i) => i !== index),
      lastError: null,
    }));
  },

  clearDraft: () => set({ wordDrafts: [], lastError: null }),

  submitDraft: async () => {
    const s0 = get();
    const drafts = s0.wordDrafts;
    if (drafts.length === 0) return;
    if (s0.submitting) return;

    // Anchor any error popup at the very first tile of the first draft path —
    // that's the most recent thing the user touched.
    const anchor: Hex | null = drafts[0]?.[0] ?? null;
    const toastAt = (text: string) => {
      if (!anchor) return;
      get().pushToast({ text, panel: 'self-hive', hex: anchor, variant: 'error' });
    };

    set({ submitting: true, lastError: null });
    try {
      const words = drafts.map((p) => draftToWord(s0.world, 'self', p));
      const results = await Promise.all(words.map((w) => validateWord(w)));
      const validPaths = drafts.filter((_, i) => results[i]);
      const invalidWords = words.filter((_, i) => !results[i]);

      if (validPaths.length === 0) {
        const msg = `not in dictionary: ${invalidWords.join(', ')}`;
        set({ submitting: false, lastError: msg });
        toastAt(msg);
        return;
      }

      const r = get().applyCommand({ kind: 'submitWords', paths: validPaths }, 'self');
      if (!r.ok) {
        set({ submitting: false });
        toastAt(r.reason);
        return;
      }
      set({
        wordDrafts: [],
        submitting: false,
        lastError:
          invalidWords.length > 0
            ? `skipped: ${invalidWords.join(', ')}`
            : null,
      });
      if (invalidWords.length > 0 && anchor) {
        get().pushToast({
          text: `skipped: ${invalidWords.join(', ')}`,
          panel: 'self-hive',
          hex: anchor,
          variant: 'error',
        });
      }
    } catch (err) {
      const msg = `submit failed: ${err instanceof Error ? err.message : String(err)}`;
      set({ submitting: false, lastError: msg });
      toastAt(msg);
    }
  },

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
    if (conn) {
      // Best-effort polite leave — the server's room teardown handles it
      // even if the frame doesn't make it out.
      conn.send({ type: 'LEAVE' });
      conn.close();
      conn = null;
    }
    set({
      mode: 'solo',
      net: { status: 'idle', lastError: null },
      room: null,
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
    conn = openRoomConnection(code, {
      onMessage: (msg) => get()._handleServerMessage(msg),
      onStatus: (status) => {
        set((s) => ({ net: { ...s.net, status } }));
      },
      onOpen: () => conn?.send({ type: 'HELLO', playerName }),
    });
  },

  joinRoom: (roomCode, playerName) => {
    if (conn) return;
    set((s) => ({ net: { ...s.net, status: 'connecting', lastError: null } }));
    conn = openRoomConnection(roomCode, {
      onMessage: (msg) => get()._handleServerMessage(msg),
      onStatus: (status) => {
        set((s) => ({ net: { ...s.net, status } }));
      },
      onOpen: () => conn?.send({ type: 'HELLO', playerName }),
    });
  },

  sendReady: () => {
    if (!conn) return;
    conn.send({ type: 'READY' });
  },

  _setConnection: (next) => {
    conn = next;
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
        set((s) => ({
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
          set({ room: null });
        }
        break;
      }
    }
  },
}));

export const draftKeySet = (drafts: readonly (readonly Hex[])[]): ReadonlyMap<string, number> => {
  const m = new Map<string, number>();
  drafts.forEach((path, idx) => {
    for (const h of path) m.set(hexKey(h), idx);
  });
  return m;
};
