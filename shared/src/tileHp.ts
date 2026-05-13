import type { TileSnapshot } from './messages.js';

/**
 * Combat durability for a hive hex.
 *
 * - Empty active hex (no letter): 1 HP → 4 queen hits
 * - Uncapped letter (`active`/`letter` state with a letter): 1.5 HP → 6 hits
 * - Capped letter (`capped` state): 2 HP → 8 hits
 * - Each reuse layer: +0.5 HP → 2 extra hits per reuse
 *
 * The queen deals 0.25 HP per strike (every 0.5s).
 */
export const hexHpForTile = (tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount'>): number => {
  if (!tile.letter) return 1;
  if (tile.state !== 'capped') return 1.5;
  return 2 + (tile.reuseCount ?? 0) * 0.5;
};

export const remainingHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'damage'>,
): number => Math.max(0, hexHpForTile(tile) - (tile.damage ?? 0));
