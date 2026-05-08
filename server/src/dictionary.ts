/**
 * Server-side word validation backed by the bundled `wordlist-english`
 * package — no network lookups. We import every frequency tier (10..70)
 * for both the dialect-neutral `english` list and the `american` list so
 * the validator accepts everything dictionaryapi.dev did, instantly.
 *
 * The full set is built once at module load. Lookups are O(1) against a
 * `Set<string>`; we keep the `async` signature only for compatibility with
 * the existing {@link import('./gameLoop.js').GameLoopPort.validateWord}
 * port shape.
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

const WORDS = buildSet();

/** Synchronous membership check. Useful for tests and direct callers. */
export const hasWord = (raw: string): boolean => {
  const word = raw.trim().toLowerCase();
  if (!/^[a-z]{2,}$/.test(word)) return false;
  return WORDS.has(word);
};

/**
 * Async wrapper kept for compatibility with the existing GameLoop port.
 * Resolves immediately — there is no network round-trip.
 */
export const isWord = async (raw: string): Promise<boolean> => hasWord(raw);
