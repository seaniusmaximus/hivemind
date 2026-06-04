/**
 * Standard Scrabble letter distribution and point values.
 * Total of 98 letters (we omit blanks — Hivemind has no wildcard mechanic).
 *
 * Point values (honey per letter when a word is capped):
 * 1 — A E I O U L N S T R
 * 2 — D G
 * 3 — B C M P
 * 4 — F H V W Y
 * 5 — K
 * 8 — J X
 * 10 — Q Z
 */

export type Letter =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J'
  | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T'
  | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

interface LetterStats {
  readonly count: number;
  readonly value: number;
}

export const LETTER_STATS: Readonly<Record<Letter, LetterStats>> = {
  A: { count: 9, value: 1 },
  B: { count: 2, value: 3 },
  C: { count: 2, value: 3 },
  D: { count: 4, value: 2 },
  E: { count: 12, value: 1 },
  F: { count: 2, value: 4 },
  G: { count: 3, value: 2 },
  H: { count: 2, value: 4 },
  I: { count: 9, value: 1 },
  J: { count: 1, value: 8 },
  K: { count: 1, value: 5 },
  L: { count: 4, value: 1 },
  M: { count: 2, value: 3 },
  N: { count: 6, value: 1 },
  O: { count: 8, value: 1 },
  P: { count: 2, value: 3 },
  Q: { count: 1, value: 10 },
  R: { count: 6, value: 1 },
  S: { count: 4, value: 1 },
  T: { count: 6, value: 1 },
  U: { count: 4, value: 1 },
  V: { count: 2, value: 4 },
  W: { count: 2, value: 4 },
  X: { count: 1, value: 8 },
  Y: { count: 2, value: 4 },
  Z: { count: 1, value: 10 },
};

export const ALL_LETTERS = Object.keys(LETTER_STATS) as Letter[];

export const letterValue = (l: Letter): number => LETTER_STATS[l].value;

/** Build the full Scrabble bag (98 letters). */
export const buildBag = (): Letter[] => {
  const bag: Letter[] = [];
  for (const letter of ALL_LETTERS) {
    const { count } = LETTER_STATS[letter];
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  return bag;
};

/** Seeded random helper. Not cryptographically secure — used for deterministic
 *  multiplayer flower spawning. Mulberry32 from Tommy Ettinger. */
export const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Draw a letter from the bag with replacement, weighted by Scrabble counts. */
export const drawLetter = (rng: () => number): Letter => {
  const total = ALL_LETTERS.reduce((s, l) => s + LETTER_STATS[l].count, 0);
  let pick = Math.floor(rng() * total);
  for (const l of ALL_LETTERS) {
    pick -= LETTER_STATS[l].count;
    if (pick < 0) return l;
  }
  return 'E';
};

/**
 * Flower-patch letter pools. Each patch in the field is one of three types:
 *
 *  - `vowel`  — vowels only (A E I O U). The bottleneck letters; high demand.
 *  - `common` — high-frequency consonants (R S T L N D). Reliable workhorses.
 *  - `rare`   — everything else: low-frequency consonants and the high-value
 *               outliers (B C F G H J K M P Q V W X Y Z). High variance, big
 *               payoffs when you hit a J/Q/X/Z.
 *
 * Within each pool, draws stay weighted by the underlying Scrabble counts so a
 * vowel patch still tilts toward A/E over O/U, and a rare patch only rarely
 * surfaces a Q or Z.
 */
export type FlowerType = 'vowel' | 'common' | 'rare' | 'special';

const VOWEL_LETTERS: readonly Letter[] = ['A', 'E', 'I', 'O', 'U'];
const COMMON_LETTERS: readonly Letter[] = ['R', 'S', 'T', 'L', 'N', 'D'];
const RARE_LETTERS: readonly Letter[] = [
  'B', 'C', 'F', 'G', 'H', 'J', 'K', 'M', 'P', 'Q', 'V', 'W', 'X', 'Y', 'Z',
];

export const FLOWER_LETTER_POOLS: Readonly<Record<
  Exclude<FlowerType, 'special'>,
  readonly Letter[]
>> = {
  vowel: VOWEL_LETTERS,
  common: COMMON_LETTERS,
  rare: RARE_LETTERS,
};

/** Draw a letter from one flower-type pool, weighted by Scrabble counts. */
export const drawFlowerLetter = (
  type: Exclude<FlowerType, 'special'>,
  rng: () => number,
): Letter => {
  const pool = FLOWER_LETTER_POOLS[type];
  const total = pool.reduce((s, l) => s + LETTER_STATS[l].count, 0);
  let pick = Math.floor(rng() * total);
  for (const l of pool) {
    pick -= LETTER_STATS[l].count;
    if (pick < 0) return l;
  }
  return pool[0]!;
};
