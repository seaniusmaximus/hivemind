/**
 * Big, conspicuous gold button anchored just under the panel-navigation tabs.
 * Clicking it dispatches the player's queen — the same action as clicking
 * your own central hive hex. Disabled when the player's queen allowance is
 * full (one queen plus one extra per multiple of `HEXES_PER_QUEEN_SLOT`
 * owned hexes), or when honey is below the queen's cost.
 */

import { activeQueenCountFor, BEE_STATS, queenAllowanceFor } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';

export const QueenSpawnButton = () => {
  const honey = useGameStore((s) => s.world.self.honey);
  const allowance = useGameStore((s) => queenAllowanceFor(s.world.self));
  const activeQueens = useGameStore((s) => activeQueenCountFor(s.world.self));
  const dispatchQueen = useGameStore((s) => s.dispatchQueen);

  const queenCost = BEE_STATS.queen.honeyCost;
  const queensFull = activeQueens >= allowance;
  const canSpawn = !queensFull && honey >= queenCost;
  const showCounter = allowance > 1 || activeQueens > 0;
  const slotSuffix = showCounter ? ` (${activeQueens}/${allowance})` : '';

  const label = queensFull
    ? `QUEENS DEPLOYED${slotSuffix}`
    : honey < queenCost
      ? `SPAWN QUEEN — ${Math.floor(honey)}/${queenCost}🜨${slotSuffix}`
      : `SPAWN QUEEN${slotSuffix}`;

  return (
    <div className="queen-spawn-bar">
      <button
        type="button"
        className="queen-spawn-button"
        disabled={!canSpawn}
        data-active={queensFull}
        onClick={() => dispatchQueen('self')}
      >
        <span className="queen-spawn-crown" aria-hidden>
          👑
        </span>
        <span className="queen-spawn-label">{label}</span>
        <span className="queen-spawn-cost" aria-hidden>
          {queenCost}🜨
        </span>
      </button>
    </div>
  );
};
