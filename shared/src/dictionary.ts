/**
 * Shared English-word dictionary backed by the bundled `wordlist-english`
 * package. The full word set is built once at module load; lookups are O(1)
 * against a `Set<string>`. Used by the AI word-finder and available to any
 * consumer of `@hivemind/shared`.
 */

import english10 from 'wordlist-english/english-words-10.json' with { type: 'json' };
import english20 from 'wordlist-english/english-words-20.json' with { type: 'json' };
import english35 from 'wordlist-english/english-words-35.json' with { type: 'json' };
import english40 from 'wordlist-english/english-words-40.json' with { type: 'json' };
import english50 from 'wordlist-english/english-words-50.json' with { type: 'json' };
import english55 from 'wordlist-english/english-words-55.json' with { type: 'json' };
import english60 from 'wordlist-english/english-words-60.json' with { type: 'json' };
import english70 from 'wordlist-english/english-words-70.json' with { type: 'json' };
import american10 from 'wordlist-english/american-words-10.json' with { type: 'json' };
import american20 from 'wordlist-english/american-words-20.json' with { type: 'json' };
import american35 from 'wordlist-english/american-words-35.json' with { type: 'json' };
import american40 from 'wordlist-english/american-words-40.json' with { type: 'json' };
import american50 from 'wordlist-english/american-words-50.json' with { type: 'json' };
import american55 from 'wordlist-english/american-words-55.json' with { type: 'json' };
import american60 from 'wordlist-english/american-words-60.json' with { type: 'json' };
import american70 from 'wordlist-english/american-words-70.json' with { type: 'json' };

const buildSet = (): ReadonlySet<string> => {
  const set = new Set<string>();
  const lists: readonly (readonly string[])[] = [
    english10, english20, english35, english40,
    english50, english55, english60, english70,
    american10, american20, american35, american40,
    american50, american55, american60, american70,
  ];
  for (const list of lists) {
    for (const w of list) set.add(w.toLowerCase());
  }
  return set;
};

/** Full English dictionary set (lowercase). */
export const WORDS = buildSet();

/** Check whether a raw string is a valid English word (>= 2 alpha chars). */
export const isWord = (raw: string): boolean => {
  const key = raw.trim().toLowerCase();
  if (!/^[a-z]{2,}$/.test(key)) return false;
  return WORDS.has(key);
};
