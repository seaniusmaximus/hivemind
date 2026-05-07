import {
  hex,
  hexEquals,
  neighbors,
  distance,
  range,
  ring,
  axialToPixel,
  pixelToAxial,
  isAdjacent,
  isValidPath,
} from './hex.js';

describe('hex math', () => {
  test('a hex equals itself', () => {
    expect(hexEquals(hex(2, -1), hex(2, -1))).toBe(true);
    expect(hexEquals(hex(2, -1), hex(2, 0))).toBe(false);
  });

  test('a hex has six unique neighbors all at distance 1', () => {
    const center = hex(0, 0);
    const ns = neighbors(center);
    expect(ns).toHaveLength(6);
    for (const n of ns) {
      expect(distance(center, n)).toBe(1);
    }
    const keys = new Set(ns.map((n) => `${n.q},${n.r}`));
    expect(keys.size).toBe(6);
  });

  test('range(center, 2) returns 19 hexes (1 + 6 + 12)', () => {
    expect(range(hex(0, 0), 2)).toHaveLength(19);
  });

  test('ring counts match 6 * radius', () => {
    expect(ring(hex(0, 0), 0)).toHaveLength(1);
    expect(ring(hex(0, 0), 1)).toHaveLength(6);
    expect(ring(hex(0, 0), 2)).toHaveLength(12);
    expect(ring(hex(3, -1), 3)).toHaveLength(18);
  });

  test('axialToPixel and pixelToAxial round-trip', () => {
    const original = hex(2, -3);
    const px = axialToPixel(original, 32);
    const back = pixelToAxial(px, 32);
    expect(back).toEqual(original);
  });

  test('isAdjacent', () => {
    expect(isAdjacent(hex(0, 0), hex(1, 0))).toBe(true);
    expect(isAdjacent(hex(0, 0), hex(2, 0))).toBe(false);
    expect(isAdjacent(hex(0, 0), hex(0, 0))).toBe(false);
  });

  test('isValidPath rejects non-adjacent steps and revisits', () => {
    expect(isValidPath([hex(0, 0), hex(1, 0), hex(1, -1)])).toBe(true);
    expect(isValidPath([hex(0, 0), hex(2, 0)])).toBe(false);
    expect(isValidPath([hex(0, 0), hex(1, 0), hex(0, 0)])).toBe(false);
    expect(isValidPath([])).toBe(false);
  });
});
