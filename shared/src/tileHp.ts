import type { TileSnapshot } from './messages.js';

/**
 * Combat durability for a hive hex.
 *
 * Rules:
 * - Empty hex (no letter): 1 HP
 * - Unsubmitted letter (`letter` state): 2 HP
 * - Capped letter (`capped` state): 4 HP
 * - Each successful capped reuse: +2 HP (`reuseCount`)
 */
export const hexHpForTile = (tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount'>): number => {
  if (!tile.letter) return 1;
  if (tile.state !== 'capped') return 2;
  return 4 + (tile.reuseCount ?? 0) * 2;
};

export const remainingHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'damage'>,
): number => Math.max(0, hexHpForTile(tile) - (tile.damage ?? 0));
