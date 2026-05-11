import { letterValue, type Letter } from './letters.js';

/** Length-based score multiplier. */
export const lengthMultiplier = (length: number): number => {
  if (length <= 4) return 1.0;
  if (length <= 6) return 1.5;
  if (length <= 8) return 2.0;
  return 3.0;
};

/** Score for a single word. */
export const wordScore = (word: readonly Letter[]): number => {
  const base = word.reduce((sum, l) => sum + letterValue(l), 0);
  return Math.round(base * lengthMultiplier(word.length));
};

/** Multiplier when a capping path includes at least one letter tile already in the `capped` state (branch / word-on-word). */
export const BRANCH_REUSE_SCORE_MULTIPLIER = 1.5;

/**
 * Honey paid for one capped word after the drone lands. If the path crossed
 * any already-capped letter (reuse / “word on word”), the payout uses
 * {@link BRANCH_REUSE_SCORE_MULTIPLIER} on that word’s {@link wordScore}.
 */
export const honeyForCappedWord = (
  word: readonly Letter[],
  crossesPriorCappedLetter: boolean,
): number => {
  const base = wordScore(word);
  return crossesPriorCappedLetter
    ? Math.round(base * BRANCH_REUSE_SCORE_MULTIPLIER)
    : base;
};
