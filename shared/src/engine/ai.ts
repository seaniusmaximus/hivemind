/**
 * Smart CPU opponent.
 *
 * Behaviour loop:
 * 1. **Collect** — send workers to flowers, preferring a balanced vowel /
 *    consonant mix so the hand can form words
 * 2. **Plan** — once storage is full (or nearly full), search the dictionary
 *    for a word that can be spelled with the stored letters + any reusable
 *    board letters, and find a contiguous placement path on the grid
 * 3. **Place + Submit** — lay the planned letters down, then cap the word
 * 4. **Carpenter** — grow the hive evenly
 * 5. **Queen** — attack when affordable
 */

import {
  hexKey,
  neighbors,
  distance,
  hex,
  type Hex,
} from '../hex.js';
import {
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
} from '../bees.js';
import type { Letter } from '../letters.js';
import type { PlayerState, TileSnapshot } from '../messages.js';
import { WORDS } from '../dictionary.js';
import {
  frontierFor,
  tileHasDraftableLetter,
  activeQueenCountFor,
  queenAllowanceFor,
  dispatchWorker,
  dispatchCarpenter,
  dispatchQueen,
  placeLetter,
  trySubmitWord,
  type World,
} from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOWELS = new Set<string>(['A', 'E', 'I', 'O', 'U']);

const isVowel = (l: Letter): boolean => VOWELS.has(l);

// ---------------------------------------------------------------------------
// Word planning: find a word from available letters and a board placement
// ---------------------------------------------------------------------------

interface PlannedWord {
  /** The word to spell. */
  readonly word: string;
  /** Letters from storage needed (indices into the storage tile list). */
  readonly storageLettersUsed: readonly { storageHex: Hex; letter: Letter }[];
  /** Target hexes on the board where each letter goes, in word order.
   *  Board-letters that are already in place have `fromStorage: false`. */
  readonly placements: readonly {
    hex: Hex;
    letter: Letter;
    fromStorage: boolean;
  }[];
}

/**
 * Given the AI's stored letters and the current board state, find a valid
 * dictionary word that can be formed and placed as a contiguous path on the
 * hex grid. Prefers longer words and words that reuse capped tiles.
 */
export const planWord = (player: PlayerState): PlannedWord | null => {
  const storedLetters: { hex: Hex; letter: Letter }[] = [];
  for (const t of player.tiles) {
    if (t.state === 'storage' && t.letter) {
      storedLetters.push({ hex: t.hex, letter: t.letter });
    }
  }
  if (storedLetters.length === 0) return null;

  const boardLettersByKey = new Map<string, { hex: Hex; letter: Letter; capped: boolean }>();
  for (const t of player.tiles) {
    if (tileHasDraftableLetter(t)) {
      boardLettersByKey.set(hexKey(t.hex), {
        hex: t.hex,
        letter: t.letter,
        capped: t.state === 'capped',
      });
    }
  }

  const origin = hex(0, 0);
  const allEmptyActives: Hex[] = [];
  const innerRingEmpty: Hex[] = [];
  for (const t of player.tiles) {
    if (t.state === 'active' && !t.letter) {
      allEmptyActives.push(t.hex);
      if (distance(t.hex, origin) === 2) innerRingEmpty.push(t.hex);
    }
  }
  const emptyActiveHexes = innerRingEmpty.length > 0 ? innerRingEmpty : allEmptyActives;

  const availableLetterCounts = new Map<string, number>();
  for (const s of storedLetters) {
    const k = s.letter;
    availableLetterCounts.set(k, (availableLetterCounts.get(k) ?? 0) + 1);
  }
  for (const bl of boardLettersByKey.values()) {
    const k = bl.letter;
    availableLetterCounts.set(k, (availableLetterCounts.get(k) ?? 0) + 1);
  }

  const usedSignatures = new Set(player.usedWordSignatures);

  let bestPlan: PlannedWord | null = null;
  let bestScore = -1;
  let checked = 0;
  const MAX_WORDS_CHECKED = 5000;

  for (const word of WORDS) {
    if (checked >= MAX_WORDS_CHECKED) break;
    if (word.length < 3 || word.length > 8) continue;
    checked++;

    const upper = word.toUpperCase();
    const needed = new Map<string, number>();
    for (const ch of upper) {
      needed.set(ch, (needed.get(ch) ?? 0) + 1);
    }
    let canSpell = true;
    for (const [ch, count] of needed) {
      if ((availableLetterCounts.get(ch) ?? 0) < count) {
        canSpell = false;
        break;
      }
    }
    if (!canSpell) continue;

    const plan = tryPlaceWord(
      upper,
      storedLetters,
      boardLettersByKey,
      emptyActiveHexes,
      usedSignatures,
    );
    if (!plan) continue;

    const reuseCount = plan.placements.filter(
      (p) => !p.fromStorage && boardLettersByKey.get(hexKey(p.hex))?.capped,
    ).length;
    const score = upper.length * 10 + reuseCount * 15;
    if (score > bestScore) {
      bestScore = score;
      bestPlan = plan;
    }
  }

  return bestPlan;
};

/**
 * Try to find a contiguous hex path for the given word using board letters
 * already in place and empty active tiles for stored letters.
 */
const tryPlaceWord = (
  word: string,
  storedLetters: readonly { hex: Hex; letter: Letter }[],
  boardLetters: ReadonlyMap<string, { hex: Hex; letter: Letter; capped: boolean }>,
  emptyActives: readonly Hex[],
  usedSignatures: ReadonlySet<string>,
): PlannedWord | null => {
  const letters = word.split('') as Letter[];
  const emptyByKey = new Set(emptyActives.map(hexKey));

  const allHexes = new Map<string, Hex>();
  for (const [k, bl] of boardLetters) allHexes.set(k, bl.hex);
  for (const h of emptyActives) allHexes.set(hexKey(h), h);

  const adjMap = new Map<string, string[]>();
  for (const [k, h] of allHexes) {
    const nbrs: string[] = [];
    for (const n of neighbors(h)) {
      const nk = hexKey(n);
      if (allHexes.has(nk)) nbrs.push(nk);
    }
    adjMap.set(k, nbrs);
  }

  type SearchState = {
    idx: number;
    path: Hex[];
    visited: Set<string>;
    storageUsed: Map<string, number>;
  };

  const storageCounts = new Map<string, number>();
  for (const s of storedLetters) {
    storageCounts.set(s.letter, (storageCounts.get(s.letter) ?? 0) + 1);
  }

  const startHexes: string[] = [];
  const firstLetter = letters[0]!;

  for (const [k, bl] of boardLetters) {
    if (bl.letter === firstLetter) startHexes.push(k);
  }
  for (const h of emptyActives) {
    const k = hexKey(h);
    if (storageCounts.has(firstLetter) && !boardLetters.has(k)) {
      startHexes.push(k);
    }
  }

  for (const startKey of startHexes) {
    const startHex = allHexes.get(startKey)!;
    const boardTile = boardLetters.get(startKey);
    const isFromStorage = !boardTile || boardTile.letter !== firstLetter;

    if (isFromStorage && !(storageCounts.get(firstLetter) ?? 0)) continue;
    if (isFromStorage && !emptyByKey.has(startKey)) continue;

    const initStorageUsed = new Map<string, number>();
    if (isFromStorage) {
      initStorageUsed.set(firstLetter, 1);
    }

    const stack: SearchState[] = [{
      idx: 1,
      path: [startHex],
      visited: new Set([startKey]),
      storageUsed: initStorageUsed,
    }];

    while (stack.length > 0) {
      const cur = stack.pop()!;

      if (cur.idx === letters.length) {
        const plan = buildPlan(word, cur.path, cur.storageUsed, storedLetters, boardLetters);
        if (plan) {
          const sig = wordSignature(plan);
          if (!usedSignatures.has(sig)) return plan;
        }
        continue;
      }

      const needed = letters[cur.idx]!;
      const prevKey = hexKey(cur.path[cur.path.length - 1]!);
      const nbrKeys = adjMap.get(prevKey) ?? [];

      for (const nk of nbrKeys) {
        if (cur.visited.has(nk)) continue;
        const nbrHex = allHexes.get(nk)!;
        const bl = boardLetters.get(nk);
        const boardMatch = bl && bl.letter === needed;
        const storageAvail = (storageCounts.get(needed) ?? 0) -
          (cur.storageUsed.get(needed) ?? 0);
        const canUseStorage = storageAvail > 0 && emptyByKey.has(nk);

        if (!boardMatch && !canUseStorage) continue;

        const newVisited = new Set(cur.visited);
        newVisited.add(nk);
        const newStorageUsed = new Map(cur.storageUsed);
        if (!boardMatch && canUseStorage) {
          newStorageUsed.set(needed, (newStorageUsed.get(needed) ?? 0) + 1);
        }

        stack.push({
          idx: cur.idx + 1,
          path: [...cur.path, nbrHex],
          visited: newVisited,
          storageUsed: newStorageUsed,
        });
      }
    }
  }

  return null;
};

const buildPlan = (
  word: string,
  path: readonly Hex[],
  storageUsed: ReadonlyMap<string, number>,
  storedLetters: readonly { hex: Hex; letter: Letter }[],
  boardLetters: ReadonlyMap<string, { hex: Hex; letter: Letter; capped: boolean }>,
): PlannedWord | null => {
  const letters = word.split('') as Letter[];
  const placements: PlannedWord['placements'][number][] = [];
  const usedStorageHexes = new Set<string>();
  const storageByLetter = new Map<string, { hex: Hex; letter: Letter }[]>();
  for (const s of storedLetters) {
    const list = storageByLetter.get(s.letter) ?? [];
    list.push(s);
    storageByLetter.set(s.letter, list);
  }
  const storagePointers = new Map<string, number>();

  for (let i = 0; i < path.length; i++) {
    const h = path[i]!;
    const letter = letters[i]!;
    const bl = boardLetters.get(hexKey(h));
    if (bl && bl.letter === letter) {
      placements.push({ hex: h, letter, fromStorage: false });
    } else {
      const pool = storageByLetter.get(letter) ?? [];
      const ptr = storagePointers.get(letter) ?? 0;
      if (ptr >= pool.length) return null;
      const source = pool[ptr]!;
      storagePointers.set(letter, ptr + 1);
      usedStorageHexes.add(hexKey(source.hex));
      placements.push({ hex: h, letter, fromStorage: true });
    }
  }

  const storageLettersUsed = storedLetters
    .filter((s) => usedStorageHexes.has(hexKey(s.hex)))
    .map((s) => ({ storageHex: s.hex, letter: s.letter }));

  return { word, storageLettersUsed, placements };
};

const wordSignature = (plan: PlannedWord): string => {
  const placements = plan.placements.map(
    (p) => `${p.hex.q},${p.hex.r}:${p.letter}`,
  );
  return `${plan.word}|${placements.sort().join('|')}`;
};

// ---------------------------------------------------------------------------
// findBestWord — search existing board letters for a submittable word
// ---------------------------------------------------------------------------

interface WordCandidate {
  readonly path: readonly Hex[];
  readonly word: string;
  readonly score: number;
  readonly reuseCount: number;
}

/**
 * Graph-walk all lettered tiles on the player's board, collecting valid
 * dictionary words already present. Used after letters have been placed.
 */
export const findBestWord = (player: PlayerState): WordCandidate | null => {
  const tileByKey = new Map<string, TileSnapshot>();
  for (const t of player.tiles) {
    if (tileHasDraftableLetter(t)) {
      tileByKey.set(hexKey(t.hex), t);
    }
  }
  if (tileByKey.size < 3) return null;

  const usedSignatures = new Set(player.usedWordSignatures);
  let best: WordCandidate | null = null;
  let explored = 0;
  const MAX_EXPLORE = 12_000;

  const adjacencyMap = new Map<string, string[]>();
  for (const [k, t] of tileByKey) {
    const nbrs: string[] = [];
    for (const n of neighbors(t.hex)) {
      const nk = hexKey(n);
      if (tileByKey.has(nk)) nbrs.push(nk);
    }
    adjacencyMap.set(k, nbrs);
  }

  const pathSignature = (path: readonly Hex[], w: string): string => {
    const placements = path.map((h, i) => `${h.q},${h.r}:${w[i]}`);
    return `${w}|${placements.sort().join('|')}`;
  };

  for (const [startKey, startTile] of tileByKey) {
    if (explored >= MAX_EXPLORE) break;

    const stack: Array<{
      key: string;
      path: Hex[];
      letters: string;
      visited: Set<string>;
      reuseCount: number;
    }> = [{
      key: startKey,
      path: [startTile.hex],
      letters: startTile.letter!.toLowerCase(),
      visited: new Set([startKey]),
      reuseCount: startTile.state === 'capped' ? 1 : 0,
    }];

    while (stack.length > 0 && explored < MAX_EXPLORE) {
      const cur = stack.pop()!;
      explored++;

      if (cur.letters.length >= 3 && WORDS.has(cur.letters)) {
        const sig = pathSignature(cur.path, cur.letters.toUpperCase());
        if (!usedSignatures.has(sig)) {
          const score = cur.letters.length * 10 + cur.reuseCount * 15;
          if (!best || score > best.score) {
            best = {
              path: cur.path,
              word: cur.letters.toUpperCase(),
              score,
              reuseCount: cur.reuseCount,
            };
          }
        }
      }

      if (cur.letters.length >= 8) continue;

      const nbrKeys = adjacencyMap.get(cur.key) ?? [];
      for (const nk of nbrKeys) {
        if (cur.visited.has(nk)) continue;
        const nbrTile = tileByKey.get(nk)!;
        const newVisited = new Set(cur.visited);
        newVisited.add(nk);
        stack.push({
          key: nk,
          path: [...cur.path, nbrTile.hex],
          letters: cur.letters + nbrTile.letter!.toLowerCase(),
          visited: newVisited,
          reuseCount: cur.reuseCount + (nbrTile.state === 'capped' ? 1 : 0),
        });
      }
    }
  }

  return best;
};

// ---------------------------------------------------------------------------
// Placement target for non-planned placement (fallback)
// ---------------------------------------------------------------------------

export const pickPlacementTarget = (player: PlayerState): TileSnapshot | null => {
  const cappedKeys = new Set<string>();
  const letteredKeys = new Set<string>();
  for (const t of player.tiles) {
    if (t.state === 'capped') cappedKeys.add(hexKey(t.hex));
    if (t.letter) letteredKeys.add(hexKey(t.hex));
  }

  const emptyActives = player.tiles.filter(
    (t) => t.state === 'active' && !t.letter,
  );
  if (emptyActives.length === 0) return null;

  const origin = hex(0, 0);
  const scored = emptyActives.map((t) => {
    const dist = distance(t.hex, origin);
    let adjacentCapped = 0;
    let adjacentLettered = 0;
    for (const n of neighbors(t.hex)) {
      const nk = hexKey(n);
      if (cappedKeys.has(nk)) adjacentCapped++;
      if (letteredKeys.has(nk)) adjacentLettered++;
    }
    const isInnerRing = dist === 2;
    const score =
      (isInnerRing ? 50 : 0) +
      adjacentCapped * 10 +
      adjacentLettered * 5 -
      dist * 2;
    return { tile: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.tile;
};

// ---------------------------------------------------------------------------
// Carpenter strategy: grow evenly in all directions
// ---------------------------------------------------------------------------

export const pickCarpenterTarget = (player: PlayerState): Hex | null => {
  const frontier = frontierFor(player);
  if (frontier.length === 0) return null;

  const origin = hex(0, 0);
  const sectorCounts = new Array<number>(6).fill(0);
  for (const t of player.tiles) {
    if (t.state === 'hive' || t.state === 'storage') continue;
    const angle = Math.atan2(t.hex.r, t.hex.q);
    const sector = ((Math.floor((angle + Math.PI) / (Math.PI / 3))) % 6 + 6) % 6;
    sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
  }

  const scored = frontier.map((h) => {
    const angle = Math.atan2(h.r, h.q);
    const sector = ((Math.floor((angle + Math.PI) / (Math.PI / 3))) % 6 + 6) % 6;
    const sectorNeed = 1 / (1 + sectorCounts[sector]!);
    const dist = distance(h, origin);
    const score = sectorNeed * 100 - dist * 2;
    return { hex: h, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.hex;
};

// ---------------------------------------------------------------------------
// Main AI tick
// ---------------------------------------------------------------------------

const AI_WORKER_COOLDOWN    = 1.5;
const AI_PLAN_COOLDOWN      = 1.0;
const AI_WORD_COOLDOWN      = 1.5;
const AI_CARPENTER_COOLDOWN = 8;
const AI_QUEEN_COOLDOWN     = 20;

export const tickSmartAi = (world: World, dt: number, rng: () => number): World => {
  if (world.phase === 'over') return world;
  let next = world;
  let {
    aiWorkerCooldown,
    aiPlaceCooldown: aiPlanCooldown,
    aiPhantomCooldown: aiWordCooldown,
    aiCarpenterCooldown,
  } = next;
  aiWorkerCooldown -= dt;
  aiPlanCooldown -= dt;
  aiWordCooldown -= dt;
  aiCarpenterCooldown -= dt;

  // ---- 1. Workers: fill storage with a balanced vowel/consonant mix ----
  if (aiWorkerCooldown <= 0) {
    const ai = next.opponent;
    const emptySlots = ai.tiles.filter((t) => t.state === 'storage' && !t.letter).length;
    const inflight = ai.bees.filter(
      (b) => b.state.kind === 'worker-flying-to-flower' ||
             b.state.kind === 'worker-flying-to-freed' ||
             b.state.kind === 'worker-flying-to-door-carrying',
    ).length;
    const slotsNeeded = emptySlots - inflight;

    if (slotsNeeded > 0 && ai.honey >= BEE_STATS.worker.honeyCost) {
      const incomingLetters: Letter[] = [];
      for (const t of ai.tiles) {
        if (t.state === 'storage' && t.letter) incomingLetters.push(t.letter);
      }
      for (const b of ai.bees) {
        if (b.state.kind === 'worker-flying-to-door-carrying') {
          incomingLetters.push(b.state.carrying);
        }
      }
      const vowelCount = incomingLetters.filter(isVowel).length;
      const consonantCount = incomingLetters.length - vowelCount;
      const needVowel = vowelCount <= consonantCount;

      const claimed = new Set<string>();
      for (const b of ai.bees) {
        if (b.state.kind === 'worker-flying-to-flower') claimed.add(hexKey(b.state.target));
        if (b.state.kind === 'worker-flying-to-freed') claimed.add(hexKey(b.state.target));
      }

      const allPetals = next.patches
        .flatMap((p) => p.petals.map((pt) => ({ hex: pt.hex, letter: pt.letter, type: p.type })))
        .filter((p) => !claimed.has(hexKey(p.hex)));

      const preferred = allPetals.filter((p) =>
        needVowel ? p.type === 'vowel' : p.type !== 'vowel',
      );
      const pool = preferred.length > 0 ? preferred : allPetals;

      const toSend = Math.min(
        slotsNeeded,
        pool.length,
        Math.floor(ai.honey / BEE_STATS.worker.honeyCost),
      );
      for (let i = 0; i < toSend; i++) {
        const pick = pool[i]!;
        const r = dispatchWorker(next, 'opponent', pick.hex);
        if (r.ok) next = r.world;
      }
    }
    aiWorkerCooldown = AI_WORKER_COOLDOWN + rng() * 0.5;
  }

  // ---- 2. Plan + Place: wait for storage to fill, plan a word, place ----
  if (aiPlanCooldown <= 0) {
    const ai = next.opponent;
    const filledSlots = ai.tiles.filter(
      (t) => t.state === 'storage' && t.letter !== null,
    );
    const inFlightWorkers = ai.bees.filter(
      (b) => b.state.kind === 'worker-flying-to-flower' ||
             b.state.kind === 'worker-flying-to-freed' ||
             b.state.kind === 'worker-flying-to-door-carrying',
    ).length;
    const storageWillFill = filledSlots.length + inFlightWorkers >= 6;
    const enoughToTry = filledSlots.length >= 3;

    if (enoughToTry && (storageWillFill || filledSlots.length >= 4)) {
      const plan = planWord(ai);
      if (plan) {
        for (const p of plan.placements) {
          if (p.fromStorage) {
            const source = plan.storageLettersUsed.find(
              (s) => s.letter === p.letter &&
                ai.tiles.some(
                  (t) => t.state === 'storage' && t.letter === s.letter &&
                  t.hex.q === s.storageHex.q && t.hex.r === s.storageHex.r,
                ),
            );
            if (source) {
              const r = placeLetter(next, 'opponent', source.storageHex, p.hex);
              if (r.ok) next = r.world;
            }
          }
        }
      } else {
        // No word plan found — dump letters near capped tiles as fallback
        for (const slot of filledSlots.slice(0, 2)) {
          const target = pickPlacementTarget(next.opponent);
          if (!target) break;
          const r = placeLetter(next, 'opponent', slot.hex, target.hex);
          if (r.ok) next = r.world;
        }
      }
    }
    aiPlanCooldown = AI_PLAN_COOLDOWN + rng() * 0.5;
  }

  // ---- 3. Word: submit any valid word found on the board ----
  if (aiWordCooldown <= 0) {
    const ai = next.opponent;
    const hasDroneInFlight = ai.bees.some((b) => b.state.kind === 'capping');
    if (!hasDroneInFlight) {
      const candidate = findBestWord(ai);
      if (candidate) {
        const r = trySubmitWord(next, 'opponent', [candidate.path]);
        if (r.ok) next = r.world;
      }
    }
    aiWordCooldown = AI_WORD_COOLDOWN + rng() * 1;
  }

  // ---- 4. Carpenter: grow hive evenly ----
  if (aiCarpenterCooldown <= 0) {
    const ai = next.opponent;
    const pending = ai.bees.some(
      (b) => b.state.kind === 'carpenter-flying' || b.state.kind === 'carpenter-returning',
    );
    if (!pending && ai.honey >= BEE_STATS.carpenter.honeyCost) {
      const target = pickCarpenterTarget(ai);
      if (target) {
        const r = dispatchCarpenter(next, 'opponent', target);
        if (r.ok) next = r.world;
      }
    }
    aiCarpenterCooldown = AI_CARPENTER_COOLDOWN + rng() * 3;
  }

  // ---- 5. Queen: attack when able ----
  const ai = next.opponent;
  const canQueen =
    ai.tiles.length >= QUEEN_MIN_OWNED_HEXES &&
    ai.honey >= BEE_STATS.queen.honeyCost &&
    activeQueenCountFor(ai) < queenAllowanceFor(ai);
  if (canQueen && rng() < dt / AI_QUEEN_COOLDOWN) {
    const r = dispatchQueen(next, 'opponent');
    if (r.ok) next = r.world;
  }

  return {
    ...next,
    aiWorkerCooldown,
    aiPlaceCooldown: aiPlanCooldown,
    aiPhantomCooldown: aiWordCooldown,
    aiCarpenterCooldown,
  };
};
