import type { TileSnapshot } from './messages.js';

/**
 * Combat durability for a hive hex.
 *
 * - `hive`: 1 HP — one queen strike destroys the hive (and its storage ring).
 * - `storage`: invincible — queens path through without attacking.
 * - Empty active hex (no letter): 1 HP → 4 queen hits
 * - Uncapped letter (`active`/`letter` state with a letter): 1.5 HP → 6 hits
 * - Capped letter (`capped` state): 2 HP → 8 hits
 * - Each reuse layer: +0.5 HP → 2 extra hits per reuse
 *
 * The queen deals 0.25 HP per strike (every 0.5s), except hive tiles which
 * are destroyed in a single strike.
 */
export const hexHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'fortification'>,
): number => {
  if (tile.state === 'hive') return 1;
  if (tile.state === 'storage') return Infinity;
  const fort = tile.fortification ?? 0;
  if (!tile.letter) return 1 + fort;
  if (tile.state !== 'capped') return 1.5 + fort;
  return 2 + (tile.reuseCount ?? 0) * 0.5 + fort;
};

/** True when a queen may damage this tile (storage is invisible to queens). */
export const isQueenAssaultableTile = (
  tile: Pick<TileSnapshot, 'state'>,
): boolean => {
  if (tile.state === 'storage') return false;
  return tile.state === 'hive' || tile.state === 'active' || tile.state === 'letter' || tile.state === 'capped' || tile.state === 'inactive';
};

export const remainingHpForTile = (
  tile: Pick<TileSnapshot, 'state' | 'letter' | 'reuseCount' | 'damage' | 'fortification'>,
): number => Math.max(0, hexHpForTile(tile) - (tile.damage ?? 0));
