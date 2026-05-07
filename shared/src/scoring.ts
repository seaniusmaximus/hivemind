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

/**
 * Score for a chain — multiple words capped on the same drone flight that
 * share at least one letter. Caller is expected to have validated the chain.
 *
 * The result is the honey bonus paid out at the moment the drone caps the
 * word(s); honey is the only currency in the game.
 */
export const chainScore = (words: readonly (readonly Letter[])[]): number => {
  if (words.length === 0) return 0;
  const total = words.reduce((s, w) => s + wordScore(w), 0);
  if (words.length === 1) return total;
  return Math.round(total * 1.5);
};
