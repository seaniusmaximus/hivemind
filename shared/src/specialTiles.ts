import type { Hex } from './hex.js';
import { hexEquals, hexKey } from './hex.js';
import { ALL_LETTERS, type Letter } from './letters.js';
import { isWord } from './dictionary.js';
import type { TileSnapshot } from './messages.js';

/** Chance each newly spawned flower patch is a special (orange) flower. */
export const SPECIAL_FLOWER_CHANCE = 0.1;

export const CASTLE_FORTIFICATION_BONUS = 2;
export const HAMMER_EXPANSION_SECONDS = 5;
/** Extra queen strike damage per stacked crown special. */
export const CROWN_QUEEN_DAMAGE_BONUS = 0.05;
/** Faster queen strikes per stacked crown special (seconds off interval). */
export const CROWN_QUEEN_INTERVAL_REDUCTION = 0.04;

export type SpecialTileKind = 'bomb' | 'castle' | 'hammer' | 'crown';

export const SPECIAL_TILE_KINDS: readonly SpecialTileKind[] = [
  'bomb',
  'castle',
  'hammer',
  'crown',
];

export const drawSpecialTileKind = (rng: () => number): SpecialTileKind =>
  SPECIAL_TILE_KINDS[Math.floor(rng() * SPECIAL_TILE_KINDS.length)]!;

export const isSpecialTileKind = (k: string): k is SpecialTileKind =>
  (SPECIAL_TILE_KINDS as readonly string[]).includes(k);

/** Client icon glyphs for special tiles (SVG text / emoji). */
export const specialTileIcon = (kind: SpecialTileKind): string => {
  switch (kind) {
    case 'bomb':
      return '💣';
    case 'castle':
      return '🏰';
    case 'hammer':
      return '🔨';
    case 'crown':
      return '👑';
  }
};

export const tileShowsSpecialIcon = (
  tile: Pick<TileSnapshot, 'specialKind' | 'letter'>,
): boolean => !!tile.specialKind && !tile.letter;

/** True when this placement can still trigger its special effect on cap. */
export const specialEffectEligible = (
  tile: Pick<TileSnapshot, 'specialKind' | 'state' | 'specialSpent'>,
): boolean =>
  !!tile.specialKind && tile.state !== 'capped' && !tile.specialSpent;

export const tileHasDraftableContent = (
  tile: TileSnapshot | undefined,
): tile is TileSnapshot => {
  if (!tile) return false;
  if (tile.state === 'capped') return !!tile.letter;
  if (tile.specialKind && (tile.state === 'active' || tile.state === 'letter')) return true;
  return (
    !!tile.letter &&
    (tile.state === 'letter' || (tile.state === 'active' && !!tile.letter))
  );
};

const buildWordFromSlots = (slots: readonly (Letter | null)[]): string | null => {
  if (slots.some((s) => s === null)) return null;
  return (slots as Letter[]).join('');
};

/**
 * Resolve wildcard special tiles on a path to a valid dictionary word.
 * Returns resolved letters per hex key (including fixed letters).
 */
export const resolveWordFromPath = (
  path: readonly Hex[],
  tiles: readonly TileSnapshot[],
): { readonly word: string; readonly resolvedByHex: ReadonlyMap<string, Letter> } | null => {
  const slots: (Letter | null)[] = [];
  const wildIndices: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const h = path[i]!;
    const tile = tiles.find((t) => hexEquals(t.hex, h));
    if (!tile || !tileHasDraftableContent(tile)) return null;
    if (tile.specialKind && !tile.letter) {
      slots.push(null);
      wildIndices.push(i);
    } else {
      slots.push(tile.letter!);
    }
  }
  if (wildIndices.length === 0) {
    const word = buildWordFromSlots(slots);
    if (!word || !isWord(word)) return null;
    const resolvedByHex = new Map<string, Letter>();
    for (let i = 0; i < path.length; i++) {
      resolvedByHex.set(hexKey(path[i]!), slots[i]!);
    }
    return { word, resolvedByHex };
  }

  const assignment: Letter[] = [];
  const resolvedByHex = new Map<string, Letter>();
  let found: string | null = null;

  const slotAt = (idx: number): Letter | null => {
    const wi = wildIndices.indexOf(idx);
    if (wi < 0) return slots[idx]!;
    return assignment[wi] ?? null;
  };

  const backtrack = (wi: number): boolean => {
    if (wi === wildIndices.length) {
      const word = buildWordFromSlots(path.map((_, idx) => slotAt(idx)));
      if (word && isWord(word)) {
        found = word;
        for (let i = 0; i < path.length; i++) {
          resolvedByHex.set(hexKey(path[i]!), slotAt(i)!);
        }
        return true;
      }
      return false;
    }
    for (const L of ALL_LETTERS) {
      assignment[wi] = L;
      if (backtrack(wi + 1)) return true;
    }
    return false;
  };

  if (!backtrack(0) || !found) return null;
  return { word: found, resolvedByHex };
};

export const wordSignatureForPath = (
  path: readonly Hex[],
  resolvedByHex: ReadonlyMap<string, Letter>,
): string => {
  const word = path.map((h) => resolvedByHex.get(hexKey(h))!).join('');
  const placements = path
    .map((h) => `${h.q},${h.r}:${resolvedByHex.get(hexKey(h))!}`)
    .sort()
    .join('|');
  return `${word}|${placements}`;
};
