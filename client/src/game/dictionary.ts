/**
 * Async word validation against `dictionaryapi.dev`, with a per-session cache
 * and a tiny pub-sub so React components can re-render when a pending lookup
 * resolves.
 *
 * Statuses returned by `wordStatus`:
 *  - `'valid'`   — confirmed in dictionary
 *  - `'invalid'` — confirmed missing
 *  - `'pending'` — fetch in flight
 *  - `'unknown'` — never asked; call `validateWord` to start a lookup
 *
 * The fetch implementation is injectable via `setFetchImpl` so tests can
 * deterministically mock results without hitting the network. On any network
 * error the lookup resolves to `true` (lenient) — better to score a real
 * word than to refuse a valid play because of a transient outage.
 */

export type WordStatus = 'valid' | 'invalid' | 'pending' | 'unknown';

const cache = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

type FetchImpl = (input: string) => Promise<{ ok: boolean }>;

let fetchImpl: FetchImpl = async (url) => {
  const r = await fetch(url);
  return { ok: r.ok };
};

/** Replace the fetch implementation. Used in tests. Pass `undefined` to reset. */
export const setFetchImpl = (impl: FetchImpl | undefined): void => {
  fetchImpl = impl ?? (async (url) => {
    const r = await fetch(url);
    return { ok: r.ok };
  });
};

/** Synchronously read the cached status for a word. */
export const wordStatus = (word: string): WordStatus => {
  const key = word.trim().toLowerCase();
  if (key.length < 2) return 'invalid';
  if (cache.has(key)) return cache.get(key) ? 'valid' : 'invalid';
  if (inflight.has(key)) return 'pending';
  return 'unknown';
};

/**
 * Kick off (or join) a lookup for `word`. Always resolves; never rejects.
 * Network errors resolve to `true` so play stays unblocked offline.
 */
export const validateWord = (word: string): Promise<boolean> => {
  const key = word.trim().toLowerCase();
  if (key.length < 2) return Promise.resolve(false);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`;
      const r = await fetchImpl(url);
      cache.set(key, r.ok);
      return r.ok;
    } catch {
      cache.set(key, true);
      return true;
    } finally {
      inflight.delete(key);
      notify();
    }
  })();
  inflight.set(key, p);
  notify();
  return p;
};

const notify = (): void => {
  for (const fn of listeners) fn();
};

/** Subscribe to cache mutations (calls `fn` after every status change). */
export const subscribeDict = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Test-only: reset cache + listeners. */
export const _resetDict = (): void => {
  cache.clear();
  inflight.clear();
  listeners.clear();
};
