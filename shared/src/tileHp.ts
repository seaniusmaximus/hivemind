import type { TileSnapshot } from './messages.js';

/** Applied to base HP tiers below (empty / letter / capped + reuse). */
const HEX_HP_SCALE = 2;

/**
 * Combat durability for a hive hex.
 *
 * Rules (values shown after {@link HEX_HP_SCALE}):
 * - Empty hex (no letter): 1 HP
 * - Unsubmitted letter (`letter` state): 2 HP
 * - Capped letter (`capped` state): 4 HP
 * - Each successful capped reuse: +2 HP (`reuseCount`)
 */
export const hexHpForTile = (tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount'>): number => {
  const base = !tile.letter
    ? 1
    : tile.state !== 'capped'
      ? 2
      : 4 + (tile.reuseCount ?? 0) * 2;
  return base * HEX_HP_SCALE;
};

export const remainingHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'damage'>,
): number => Math.max(0, hexHpForTile(tile) - (tile.damage ?? 0));
