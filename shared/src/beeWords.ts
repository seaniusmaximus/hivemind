/**
 * Words that trigger the "pollen bloom" expansion bonus: after capping, every
 * eligible hex adjacent to the word path is auto-expanded (no n − 2 limit).
 *
 * Tiles use uppercase letters only; entries match the spelled word exactly.
 */

const BEE_RELATED_WORDS_LIST = [
  'QUEEN',
  'WORKER',
  'DRONE',
  'CARPENTER',
  'SCOUT',
  'APIARY',
  'HONEY',
  'BROOD',
  'SWARM',
  'WAGGLE',
  'COMB',
  'HONEYCOMB',
  'WAX',
  'BEESWAX',
  'NECTAR',
  'POLLEN',
  'THORAX',
  'ANTENNAE',
  'PROBOSCIS',
  'WING',
  'WINGS',
  'LARVA',
  'LARVAE',
] as const;

export const BEE_RELATED_WORDS: ReadonlySet<string> = new Set(BEE_RELATED_WORDS_LIST);

/** True when the spelled word exactly matches a {@link BEE_RELATED_WORDS} entry. */
export const isBeeRelatedWord = (word: string): boolean =>
  BEE_RELATED_WORDS.has(word.trim());
