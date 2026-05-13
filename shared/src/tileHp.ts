import type { TileSnapshot } from './messages.js';

/**
 * Combat durability for a hive hex.
 *
 * - Empty active hex (no letter): 1 HP → 2 queen hits
 * - Uncapped letter (`active`/`letter` state with a letter): 1.5 HP → 3 hits
 * - Capped letter (`capped` state): 2 HP → 4 hits
 * - Each reuse layer: +0.5 HP → 1 extra hit per reuse
 *
 * The queen deals 1 HP per strike.
 */
export const hexHpForTile = (tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount'>): number => {
  if (!tile.letter) return 1;
  if (tile.state !== 'capped') return 1.5;
  return 2 + (tile.reuseCount ?? 0) * 0.5;
};

export const remainingHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'damage'>,
): number => Math.max(0, hexHpForTile(tile) - (tile.damage ?? 0));
