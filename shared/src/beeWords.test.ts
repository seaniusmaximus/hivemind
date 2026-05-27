import { isBeeRelatedWord } from './beeWords.js';

describe('isBeeRelatedWord', () => {
  it('matches listed bee-themed words exactly', () => {
    expect(isBeeRelatedWord('QUEEN')).toBe(true);
    expect(isBeeRelatedWord('HONEYCOMB')).toBe(true);
    expect(isBeeRelatedWord('LARVAE')).toBe(true);
  });

  it('rejects unrelated or partial words', () => {
    expect(isBeeRelatedWord('CAT')).toBe(false);
    expect(isBeeRelatedWord('HONEYS')).toBe(true);
    expect(isBeeRelatedWord('HOUSE')).toBe(false);
    expect(isBeeRelatedWord('')).toBe(false);
  });
});
