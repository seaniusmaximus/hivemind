import { honeyForCappedWord, recordBestWord, wordScore } from './scoring.js';
import type { Letter } from './letters.js';
import type { PlayerState } from './messages.js';

const emptyPlayer = (id: string): PlayerState => ({
  id,
  honey: 0,
  tiles: [],
  bees: [],
  usedWordSignatures: [],
  bestWord: '',
  bestWordScore: 0,
});

const word = (s: string): Letter[] => [...s] as Letter[];

describe('scoring', () => {
  test('CAT scores 5 (C3 + A1 + T1)', () => {
    expect(wordScore(word('CAT'))).toBe(5);
  });

  test('QUARTZ scores 24 (Q10+U1+A1+R1+T1+Z10)', () => {
    expect(wordScore(word('QUARTZ'))).toBe(24);
  });

  test('honeyForCappedWord applies 1.5× when path crossed a prior-capped letter', () => {
    const cat = wordScore(word('CAT'));
    expect(honeyForCappedWord(word('CAT'), false)).toBe(cat);
    expect(honeyForCappedWord(word('CAT'), true)).toBe(Math.round(cat * 1.5));
  });

  test('recordBestWord keeps the highest-scoring cap', () => {
    let p = recordBestWord(emptyPlayer('self'), word('CAT'), false);
    expect(p.bestWord).toBe('CAT');
    expect(p.bestWordScore).toBe(5);
    p = recordBestWord(p, word('QUARTZ'), false);
    expect(p.bestWord).toBe('QUARTZ');
    expect(p.bestWordScore).toBe(24);
    p = recordBestWord(p, word('AT'), false);
    expect(p.bestWord).toBe('QUARTZ');
    expect(p.bestWordScore).toBe(24);
  });
});
