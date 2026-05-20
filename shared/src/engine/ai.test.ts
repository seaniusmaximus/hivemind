import { hex, hexKey } from '../hex.js';
import { makeRng } from '../letters.js';
import { BEE_STATS, QUEEN_MIN_OWNED_HEXES } from '../bees.js';
import type { Letter } from '../letters.js';
import type { PlayerState, TileSnapshot } from '../messages.js';
import {
  buildInitialWorld,
  frontierFor,
  placeLetter,
  tickWorld,
  tickSolo,
  type World,
} from './state.js';
import { WORKER_HOLD_SECONDS } from '../bees.js';
import {
  AI_ACTION_DELAY_SEC,
  findBestWord,
  planWord,
  pickPlacementTarget,
  pickCarpenterTarget,
  tickSmartAi,
} from './ai.js';

const fixedRng = () => makeRng(42);

const advance = (world: World, seconds: number, rng = fixedRng()): World => {
  const step = 1 / 30;
  let w = world;
  let elapsed = 0;
  while (elapsed < seconds) {
    w = tickWorld(w, step, rng);
    elapsed += step;
  }
  return w;
};

const advanceSolo = (world: World, seconds: number, rng = fixedRng()): World => {
  const step = 1 / 30;
  let w = world;
  let elapsed = 0;
  while (elapsed < seconds) {
    w = tickSolo(w, step, rng);
    elapsed += step;
  }
  return w;
};

const setTileState = (
  w: World,
  side: 'self' | 'opponent',
  updates: Array<{ hex: { q: number; r: number }; letter: Letter | null; state?: TileSnapshot['state'] }>,
): World => {
  const player = w[side];
  const newTiles = player.tiles.map((t) => {
    const match = updates.find((u) => u.hex.q === t.hex.q && u.hex.r === t.hex.r);
    if (match) {
      return { ...t, letter: match.letter, state: match.state ?? t.state } as TileSnapshot;
    }
    return t;
  });
  return { ...w, [side]: { ...player, tiles: newTiles } };
};

// ---- findBestWord -----------------------------------------------------------

describe('findBestWord', () => {
  it('returns null when there are fewer than 3 lettered tiles', () => {
    const w = buildInitialWorld(fixedRng());
    expect(findBestWord(w.opponent)).toBeNull();
  });

  it('finds a valid word from adjacent lettered tiles', () => {
    let w = buildInitialWorld(fixedRng());
    const actives = w.opponent.tiles.filter((t) => t.state === 'active').slice(0, 5);
    const letters: Letter[] = ['C', 'A', 'T', 'S', 'E'];
    const updates = actives.map((t, i) => ({
      hex: t.hex,
      letter: letters[i]!,
      state: 'active' as const,
    }));
    w = setTileState(w, 'opponent', updates);

    const result = findBestWord(w.opponent);
    expect(result).not.toBeNull();
    expect(result!.word.length).toBeGreaterThanOrEqual(3);
  });
});

// ---- planWord ---------------------------------------------------------------

describe('planWord', () => {
  it('returns null when storage is empty', () => {
    const w = buildInitialWorld(fixedRng());
    expect(planWord(w.opponent)).toBeNull();
  });

  it('plans a word from stored letters', () => {
    let w = buildInitialWorld(fixedRng());
    const storageSlots = w.opponent.tiles.filter((t) => t.state === 'storage');
    const letters: Letter[] = ['C', 'A', 'T'];
    const updates = storageSlots.slice(0, 3).map((t, i) => ({
      hex: t.hex,
      letter: letters[i]!,
      state: 'storage' as const,
    }));
    w = setTileState(w, 'opponent', updates);

    const plan = planWord(w.opponent);
    expect(plan).not.toBeNull();
    if (plan) {
      expect(plan.word.length).toBeGreaterThanOrEqual(3);
      expect(plan.storageLettersUsed.length).toBeGreaterThan(0);
      expect(plan.placements.length).toBe(plan.word.length);
      for (const p of plan.placements) {
        expect(typeof p.fromStorage).toBe('boolean');
      }
    }
  });

  it('plans a word that reuses capped board letters', () => {
    let w = buildInitialWorld(fixedRng());
    const actives = w.opponent.tiles.filter((t) => t.state === 'active');
    w = setTileState(w, 'opponent', [
      { hex: actives[0]!.hex, letter: 'C', state: 'capped' },
    ]);
    const storageSlots = w.opponent.tiles.filter((t) => t.state === 'storage');
    w = setTileState(w, 'opponent', [
      { hex: storageSlots[0]!.hex, letter: 'A', state: 'storage' },
      { hex: storageSlots[1]!.hex, letter: 'T', state: 'storage' },
    ]);

    const plan = planWord(w.opponent);
    if (plan) {
      const boardPlacements = plan.placements.filter((p) => !p.fromStorage);
      expect(boardPlacements.length).toBeGreaterThan(0);
    }
  });
});

// ---- pickPlacementTarget ----------------------------------------------------

describe('pickPlacementTarget', () => {
  it('returns an empty active tile', () => {
    const w = buildInitialWorld(fixedRng());
    const target = pickPlacementTarget(w.opponent);
    if (target) {
      expect(target.state).toBe('active');
      expect(target.letter).toBeNull();
    }
  });
});

// ---- pickCarpenterTarget ----------------------------------------------------

describe('pickCarpenterTarget', () => {
  it('returns a frontier hex', () => {
    const w = buildInitialWorld(fixedRng());
    const target = pickCarpenterTarget(w.opponent);
    expect(target).not.toBeNull();
    const frontier = frontierFor(w.opponent);
    expect(frontier.some((f) => f.q === target!.q && f.r === target!.r)).toBe(true);
  });
});

// ---- tickSmartAi integration ------------------------------------------------

describe('tickSmartAi', () => {
  it('easy difficulty arms an action gate after the CPU acts', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng, undefined, { aiDifficulty: 'easy' });
    w = {
      ...w,
      aiWorkerCooldown: 0,
      aiActionDelay: 0,
      opponent: { ...w.opponent, honey: 500 },
    };
    const beesBefore = w.opponent.bees.length;
    w = tickSmartAi(w, 1 / 30, rng);
    w = tickSmartAi(w, WORKER_HOLD_SECONDS, rng);
    expect(w.opponent.bees.length).toBe(beesBefore + 1);
    expect(w.aiActionDelay).toBeCloseTo(AI_ACTION_DELAY_SEC.easy, 5);
    const beesMidGate = w.opponent.bees.length;
    w = tickSmartAi(w, 0.5, rng);
    expect(w.opponent.bees.length).toBe(beesMidGate);
    expect(w.aiActionDelay).toBeGreaterThan(0);
  });

  it('medium difficulty waits for the human hold timer before one worker dispatch', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng, undefined, { aiDifficulty: 'medium' });
    w = {
      ...w,
      aiWorkerCooldown: 0,
      aiActionDelay: 0,
      opponent: { ...w.opponent, honey: 500 },
    };
    const beesBefore = w.opponent.bees.length;
    w = tickSmartAi(w, 1 / 30, rng);
    expect(w.opponent.bees.length).toBe(beesBefore);
    expect(w.aiWorkerHoldHex).not.toBeNull();
    w = tickSmartAi(w, WORKER_HOLD_SECONDS, rng);
    expect(w.opponent.bees.length).toBe(beesBefore + 1);
    expect(w.aiWorkerHoldHex).toBeNull();
  });

  it('hard difficulty does not arm an action gate', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng, undefined, { aiDifficulty: 'hard' });
    w = {
      ...w,
      aiWorkerCooldown: 0,
      aiActionDelay: 0,
      opponent: { ...w.opponent, honey: 500 },
    };
    w = tickSmartAi(w, 1 / 30, rng);
    expect(w.aiActionDelay).toBe(0);
  });

  it('does not crash on a fresh world', () => {
    const rng = fixedRng();
    const w = buildInitialWorld(rng);
    const result = tickSmartAi(w, 1 / 30, rng);
    expect(result).toBeDefined();
    expect(result.opponent).toBeDefined();
  });

  it('runs for 60s without throwing', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, opponent: { ...w.opponent, honey: 200 } };
    expect(() => advanceSolo(w, 60, rng)).not.toThrow();
  });

  it('AI submits at least one word within 120s', () => {
    const rng = fixedRng();
    let w = buildInitialWorld(rng);
    w = { ...w, opponent: { ...w.opponent, honey: 200 } };
    w = advanceSolo(w, 120, rng);

    const hasCappedTiles = w.opponent.tiles.some((t) => t.state === 'capped');
    const hasUsedSignatures = w.opponent.usedWordSignatures.length > 0;
    expect(hasCappedTiles || hasUsedSignatures).toBe(true);
  });
});
