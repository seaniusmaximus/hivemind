/**
 * Words that trigger the "pollen bloom" bonus: after capping, every eligible
 * hex adjacent to the word path is auto-expanded (no n − 2 limit), and the
 * flower field grows one vowel, one common, and one uncommon patch.
 *
 * Tiles use uppercase letters only; entries match the spelled word exactly.
 */

const BEE_RELATED_WORDS_LIST = [
  'HIVE',
  'HIVES',
  'FLOWER',
  'FLOWERS',
  'BEE',
  'BEES',
  'QUEEN',
  'QUEENS',
  'WORKER',
  'WORKERS',
  'DRONE',
  'DRONES',
  'CARPENTER',
  'CARPENTERS',
  'SCOUT',
  'SCOUTS',
  'APIARY',
  'APIARIES',
  'HONEY',
  'HONEYS',
  'BROOD',
  'BROODS',
  'SWARM',
  'SWARMS',
  'WAGGLE',
  'WAGGLES',
  'COMB',
  'COMBS',
  'HONEYCOMB',
  'HONEYCOMBS',
  'WAX',
  'BEESWAX',
  'NECTAR',
  'POLLEN',
  'THORAX',
  'ANTENNAE',
  'PROBOSCIS',
  'WING',
  'WINGED',
  'WINGS',
  'EGG',
  'EGGS',
  'LARVA',
  'LARVAE',
] as const;

export const BEE_RELATED_WORDS: ReadonlySet<string> = new Set(BEE_RELATED_WORDS_LIST);

/** True when the spelled word exactly matches a {@link BEE_RELATED_WORDS} entry. */
export const isBeeRelatedWord = (word: string): boolean =>
  BEE_RELATED_WORDS.has(word.trim());
