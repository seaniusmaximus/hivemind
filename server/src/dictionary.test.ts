import { hasWord, isWord } from './dictionary.js';

describe('server dictionary: bundled wordlist-english', () => {
  test('common words resolve as valid', async () => {
    expect(hasWord('cat')).toBe(true);
    expect(hasWord('hello')).toBe(true);
    expect(hasWord('hexagon')).toBe(true);
    expect(await isWord('CAT')).toBe(true);
  });

  test('non-words and gibberish resolve as invalid', async () => {
    expect(hasWord('blerg')).toBe(false);
    expect(hasWord('xyzzy')).toBe(false);
    expect(await isWord('asdfghjkl')).toBe(false);
  });

  test('inputs are trimmed, lowercased, and length-gated', async () => {
    expect(hasWord(' Cat ')).toBe(true);
    expect(hasWord('A')).toBe(false);
    expect(hasWord('')).toBe(false);
    expect(hasWord('1cat')).toBe(false);
  });

  test('american spellings are accepted', async () => {
    expect(hasWord('color')).toBe(true);
    expect(hasWord('flavor')).toBe(true);
  });
});
