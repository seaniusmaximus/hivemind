/**
 * Pointy-top hexagonal grid math.
 *
 * Storage uses axial coordinates (q, r). Distance/neighbor calculations use
 * cube coordinates derived from axial. Reference:
 * https://www.redblobgames.com/grids/hexagons/
 */

export interface Hex {
  readonly q: number;
  readonly r: number;
}

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export const hex = (q: number, r: number): Hex => ({ q, r });

export const hexEquals = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

export const hexKey = (h: Hex): string => `${h.q},${h.r}`;

/** Six unit vectors in axial coordinates, starting east, going counter-clockwise. */
const AXIAL_DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const neighbor = (h: Hex, direction: number): Hex => {
  const d = AXIAL_DIRECTIONS[((direction % 6) + 6) % 6]!;
  return { q: h.q + d.q, r: h.r + d.r };
};

export const neighbors = (h: Hex): readonly Hex[] =>
  AXIAL_DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));

/** Cube distance between two hexes. */
export const distance = (a: Hex, b: Hex): number => {
  const ax = a.q;
  const az = a.r;
  const ay = -ax - az;
  const bx = b.q;
  const bz = b.r;
  const by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
};

/** All hexes within `radius` rings of `center`, including the center. */
export const range = (center: Hex, radius: number): Hex[] => {
  const result: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      result.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return result;
};

/** Hexes that form the ring exactly `radius` away from `center`. */
export const ring = (center: Hex, radius: number): Hex[] => {
  if (radius === 0) return [center];
  const results: Hex[] = [];
  let current: Hex = {
    q: center.q + AXIAL_DIRECTIONS[4]!.q * radius,
    r: center.r + AXIAL_DIRECTIONS[4]!.r * radius,
  };
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      results.push(current);
      current = neighbor(current, i);
    }
  }
  return results;
};

/** Pixel position of a hex's center, given hex `size` (corner-to-center distance). */
export const axialToPixel = (h: Hex, size: number): PixelPoint => {
  const x = size * Math.sqrt(3) * (h.q + h.r / 2);
  const y = size * (3 / 2) * h.r;
  return { x, y };
};

/** Convert a pixel position back to the nearest hex (with cube rounding). */
export const pixelToAxial = (p: PixelPoint, size: number): Hex => {
  const q = ((Math.sqrt(3) / 3) * p.x - (1 / 3) * p.y) / size;
  const r = ((2 / 3) * p.y) / size;
  return cubeRound(q, r);
};

const cubeRound = (qf: number, rf: number): Hex => {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
};

/** Whether two hexes are exactly one step apart. */
export const isAdjacent = (a: Hex, b: Hex): boolean => distance(a, b) === 1;

/**
 * If `path` visits exactly the six hexes ringing some cell (and not the center
 * itself), return that center. Used for satellite-hive founding.
 */
export const ringCenterForPath = (path: readonly Hex[]): Hex | null => {
  if (path.length !== 6) return null;
  const pathKeys = new Set(path.map(hexKey));
  if (pathKeys.size !== 6) return null;
  for (const tile of path) {
    for (const candidate of neighbors(tile)) {
      if (pathKeys.has(hexKey(candidate))) continue;
      const ring = neighbors(candidate);
      if (ring.every((h) => pathKeys.has(hexKey(h)))) return candidate;
    }
  }
  return null;
};

/** Whether `path` is a contiguous, non-revisiting walk on the hex grid. */
export const isValidPath = (path: readonly Hex[]): boolean => {
  if (path.length === 0) return false;
  const seen = new Set<string>();
  for (let i = 0; i < path.length; i++) {
    const here = path[i]!;
    const key = hexKey(here);
    if (seen.has(key)) return false;
    seen.add(key);
    if (i > 0 && !isAdjacent(path[i - 1]!, here)) return false;
  }
  return true;
};
