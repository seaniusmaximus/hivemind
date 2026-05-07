import { wordScore, chainScore, damageFor, lengthMultiplier } from './scoring.js';
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

  test('chain of two words gets 1.5x', () => {
    const cat = wordScore(word('CAT'));
    const dog = wordScore(word('DOG'));
    expect(chainScore([word('CAT'), word('DOG')])).toBe(Math.round((cat + dog) * 1.5));
  });

  test('damageFor floors score / 4', () => {
    expect(damageFor(0)).toBe(0);
    expect(damageFor(7)).toBe(1);
    expect(damageFor(40)).toBe(10);
  });
});
