/**
 * Local English-word validation backed by the bundled `wordlist-english`
 * package. Lookups are synchronous and free — no network calls — but we
 * preserve the previous async + pub/sub surface so call sites in the game
 * store and word builder don't need to change.
 *
 * Statuses returned by {@link wordStatus}:
 *  - `'valid'`   — word exists in the bundled list
 *  - `'invalid'` — word does not exist (or fails sanitation)
 *  - `'pending'` — never produced (kept for type compat)
 *  - `'unknown'` — never produced (kept for type compat)
 *
 * The fetch implementation hook (`setFetchImpl`) is a no-op; tests no longer
 * need to mock the network. {@link _resetDict} exists for symmetry with the
 * older API and is currently a no-op as well — there is no per-session cache
 * because the local list is the single source of truth.
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

export type WordStatus = 'valid' | 'invalid' | 'pending' | 'unknown';

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

const isInList = (raw: string): boolean => {
  const key = raw.trim().toLowerCase();
  if (!/^[a-z]{2,}$/.test(key)) return false;
  return WORDS.has(key);
};

/** Synchronously read the validity of a word. */
export const wordStatus = (word: string): WordStatus =>
  isInList(word) ? 'valid' : 'invalid';

/**
 * Resolve to a boolean indicating whether `word` is in the local dictionary.
 * Always resolves; never rejects. Kept async-shaped for compatibility with
 * the existing call sites in the game store.
 */
export const validateWord = (word: string): Promise<boolean> =>
  Promise.resolve(isInList(word));

/** No-op subscriber kept so existing components don't need to drop the call. */
export const subscribeDict = (_fn: () => void): (() => void) => () => {};

/**
 * Test seam preserved for API compatibility — the implementation no longer
 * fetches anything, so this is a no-op.
 */
export const setFetchImpl = (
  _impl: ((input: string) => Promise<{ ok: boolean }>) | undefined,
): void => {};

/** Test seam preserved for API compatibility; the local set is immutable. */
export const _resetDict = (): void => {};
