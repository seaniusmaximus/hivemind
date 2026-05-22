import { letterValue, type Letter } from './letters.js';
import type { PlayerState } from './messages.js';

/** Sum of per-letter point values for a word (no length multiplier). */
export const wordScore = (word: readonly Letter[]): number =>
  word.reduce((sum, l) => sum + letterValue(l), 0);

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

/** Update a player's match best if this capped word scored higher. */
export const recordBestWord = (
  player: PlayerState,
  letters: readonly Letter[],
  crossesPriorCappedLetter: boolean,
): PlayerState => {
  const score = honeyForCappedWord(letters, crossesPriorCappedLetter);
  if (score <= player.bestWordScore) return player;
  return {
    ...player,
    bestWord: letters.join(''),
    bestWordScore: score,
  };
};
