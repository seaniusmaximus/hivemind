import { honeyForCappedWord, wordScore, lengthMultiplier } from './scoring.js';
import type { Letter } from './letters.js';

const word = (s: string): Letter[] => [...s] as Letter[];

describe('scoring', () => {
  test('lengthMultiplier brackets', () => {
    expect(lengthMultiplier(3)).toBe(1.0);
    expect(lengthMultiplier(5)).toBe(1.5);
    expect(lengthMultiplier(7)).toBe(2.0);
    expect(lengthMultiplier(9)).toBe(3.0);
  });

  test('CAT scores 5 (C3 + A1 + T1)', () => {
    expect(wordScore(word('CAT'))).toBe(5);
  });

  test('QUARTZ scores 24 (Q10+U1+A1+R1+T1+Z10 = 24, *1.5 = 36)', () => {
    expect(wordScore(word('QUARTZ'))).toBe(36);
  });

  test('honeyForCappedWord applies 1.5× when path crossed a prior-capped letter', () => {
    const cat = wordScore(word('CAT'));
    expect(honeyForCappedWord(word('CAT'), false)).toBe(cat);
    expect(honeyForCappedWord(word('CAT'), true)).toBe(Math.round(cat * 1.5));
  });
});
