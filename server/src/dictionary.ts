/**
 * Server-side word validation against dictionaryapi.dev with an LRU cache.
 * Uses the global `fetch` available in Node 20+.
 */

const CACHE_MAX = 5000;
const cache = new Map<string, boolean>();

const cacheGet = (key: string): boolean | undefined => {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
};

const cacheSet = (key: string, value: boolean): void => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
};

export const isWord = async (raw: string): Promise<boolean> => {
  const word = raw.trim().toLowerCase();
  if (!/^[a-z]{2,}$/.test(word)) return false;
  const cached = cacheGet(word);
  if (cached !== undefined) return cached;

  try {
    const resp = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
    );
    const valid = resp.ok;
    cacheSet(word, valid);
    return valid;
  } catch {
    // On network failure, be lenient rather than denying play.
    return true;
  }
};
