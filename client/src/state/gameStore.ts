import { create } from 'zustand';
import {
  BEE_STATS,
  hexEquals,
  hexKey,
  isAdjacent,
  makeRng,
  type Hex,
  type Letter,
  type TileSnapshot,
} from '@hivemind/shared';
import {
  buildInitialWorld,
  placeLetter as enginePlaceLetter,
  toggleCarpenterTarget as engineToggleCarpenter,
  toggleLetterQueue as engineToggleQueue,
  trySpawnCarpenter,
  trySpawnWorker,
  trySubmitWord,
  tickWorld,
  type Side,
  type World,
} from '../game/engine/state.js';
import { validateWord, wordStatus } from '../game/dictionary.js';

export type PanelIndex = 0 | 1 | 2;

export interface LetterDrag {
  readonly fromHex: Hex;
  readonly letter: Letter;
}

interface GameStore {
  panel: PanelIndex;
  setPanel: (panel: PanelIndex) => void;

  world: World;
  /**
   * Up to `BEE_STATS.drone.capacity` paths the player has drafted. Each path
   * becomes one capped word when the drone is dispatched. The last entry is
   * the path currently being extended by the active drag (if any).
   */
  wordDrafts: readonly (readonly Hex[])[];
  /** Set while the user is drag-moving a letter from a storage slot. */
  letterDrag: LetterDrag | null;
  /** The active tile currently hovered as a drop target during letter drag. */
  dropHover: Hex | null;
  /** Async submit in progress (awaiting dictionary). */
  submitting: boolean;
  /** Last error from a refused command (cleared on next success). */
  lastError: string | null;

  initSolo: (seed?: number) => void;
  tick: (dt: number) => void;

  toggleLetterQueue: (h: Hex, side?: Side) => void;
  spawnWorker: (side?: Side) => void;

  toggleCarpenterTarget: (h: Hex, side?: Side) => void;
  spawnCarpenter: (side?: Side) => void;

  // Letter movement: storage → active.
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
}

let rng: () => number = makeRng(1);

const reseed = (seed: number) => {
  rng = makeRng(seed);
};

const tileAt = (world: World, side: Side, h: Hex): TileSnapshot | undefined =>
  world[side].tiles.find((t) => hexEquals(t.hex, h));

const isLetterOrCapped = (tile: TileSnapshot | undefined): boolean =>
  !!tile && (tile.state === 'letter' || tile.state === 'capped') && !!tile.letter;

const draftToWord = (world: World, side: Side, path: readonly Hex[]): string =>
  path
    .map((h) => tileAt(world, side, h)?.letter ?? '')
    .join('')
    .toUpperCase();

export const useGameStore = create<GameStore>((set, get) => ({
  panel: 1,
  setPanel: (panel) => set({ panel }),

  world: buildInitialWorld(rng),
  wordDrafts: [],
  letterDrag: null,
  dropHover: null,
  submitting: false,
  lastError: null,

  initSolo: (seed) => {
    reseed(seed ?? Date.now() & 0xffffffff);
    set({
      world: buildInitialWorld(rng),
      wordDrafts: [],
      letterDrag: null,
      dropHover: null,
      submitting: false,
      lastError: null,
      panel: 1,
    });
  },

  tick: (dt) => {
    set((s) => ({ world: tickWorld(s.world, dt, rng) }));
  },

  toggleLetterQueue: (h, side = 'self') => {
    set((s) => {
      const r = engineToggleQueue(s.world, side, h);
      return r.ok ? { world: r.world, lastError: null } : { lastError: r.reason };
    });
  },

  spawnWorker: (side = 'self') => {
    set((s) => {
      const r = trySpawnWorker(s.world, side);
      return r.ok ? { world: r.world, lastError: null } : { lastError: r.reason };
    });
  },

  toggleCarpenterTarget: (h, side = 'self') => {
    set((s) => {
      const r = engineToggleCarpenter(s.world, side, h);
      return r.ok ? { world: r.world, lastError: null } : { lastError: r.reason };
    });
  },

  spawnCarpenter: (side = 'self') => {
    set((s) => {
      const r = trySpawnCarpenter(s.world, side);
      return r.ok ? { world: r.world, lastError: null } : { lastError: r.reason };
    });
  },

  startLetterDrag: (fromHex) => {
    set((s) => {
      const tile = tileAt(s.world, 'self', fromHex);
      if (!tile || tile.state !== 'storage' || !tile.letter) return s;
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
      if (!tile || tile.state !== 'active' || tile.letter) return { dropHover: null };
      return { dropHover: h };
    });
  },

  commitLetterDrag: () => {
    set((s) => {
      const drag = s.letterDrag;
      const target = s.dropHover;
      if (!drag) return s;
      if (!target) return { letterDrag: null, dropHover: null };
      const r = enginePlaceLetter(s.world, 'self', drag.fromHex, target);
      if (!r.ok) {
        return { letterDrag: null, dropHover: null, lastError: r.reason };
      }
      return { world: r.world, letterDrag: null, dropHover: null, lastError: null };
    });
  },

  cancelLetterDrag: () => set({ letterDrag: null, dropHover: null }),

  startDraft: (h) => {
    set((s) => {
      const tile = tileAt(s.world, 'self', h);
      if (!isLetterOrCapped(tile)) return s;
      const cap = BEE_STATS.drone.capacity;
      if (s.wordDrafts.length >= cap) {
        return { lastError: `up to ${cap} words per drone` };
      }
      return {
        wordDrafts: [...s.wordDrafts, [h]],
        letterDrag: null,
        dropHover: null,
        lastError: null,
      };
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
      if (!isLetterOrCapped(tile)) return s;
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

    set({ submitting: true, lastError: null });
    try {
      const words = drafts.map((p) => draftToWord(s0.world, 'self', p));
      const results = await Promise.all(words.map((w) => validateWord(w)));
      const validPaths = drafts.filter((_, i) => results[i]);
      const invalidWords = words.filter((_, i) => !results[i]);

      if (validPaths.length === 0) {
        set({
          submitting: false,
          lastError: `not in dictionary: ${invalidWords.join(', ')}`,
        });
        return;
      }

      set((s) => {
        const r = trySubmitWord(s.world, 'self', validPaths);
        if (!r.ok) {
          return { submitting: false, lastError: r.reason };
        }
        return {
          world: r.world,
          wordDrafts: [],
          submitting: false,
          lastError:
            invalidWords.length > 0
              ? `skipped: ${invalidWords.join(', ')}`
              : null,
        };
      });
    } catch (err) {
      set({
        submitting: false,
        lastError: `submit failed: ${err instanceof Error ? err.message : String(err)}`,
      });
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
