/**
 * Big, conspicuous gold button anchored just under the panel-navigation tabs.
 * Clicking it dispatches the player's queen — the same action as clicking
 * your own central hive hex. Disabled when a queen is already in flight or
 * the assault is underway, or when honey is below the queen's cost.
 */

import { BEE_STATS } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';

export const QueenSpawnButton = () => {
  const honey = useGameStore((s) => s.world.self.honey);
  const queenInPlay = useGameStore((s) =>
    s.world.self.bees.some(
      (b) => b.state.kind === 'queen-flying' || b.state.kind === 'queen-assault',
    ),
  );
  const dispatchQueen = useGameStore((s) => s.dispatchQueen);

  const queenCost = BEE_STATS.queen.honeyCost;
  const canSpawn = !queenInPlay && honey >= queenCost;

  const label = queenInPlay
    ? 'QUEEN IN FLIGHT'
    : honey < queenCost
      ? `SPAWN QUEEN — ${Math.floor(honey)}/${queenCost}🜨`
      : 'SPAWN QUEEN';

  return (
    <div className="queen-spawn-bar">
      <button
        type="button"
        className="queen-spawn-button"
        disabled={!canSpawn}
        data-active={queenInPlay}
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
