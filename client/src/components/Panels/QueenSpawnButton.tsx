/**
 * Gold call-to-action between the panel tabs and the deck. Starts queen
 * targeting (rival mini-board); click again while targeting to cancel.
 */

import {
  activeQueenCountFor,
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
  queenAllowanceFor,
} from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { QueenBeeIcon } from '../Bee/QueenBeeIcon.js';

export const QueenSpawnButton = () => {
  const honey = useGameStore((s) => s.world.self.honey);
  const tileCount = useGameStore((s) => s.world.self.tiles.length);
  const allowance = useGameStore((s) => queenAllowanceFor(s.world.self));
  const activeQueens = useGameStore((s) => activeQueenCountFor(s.world.self));
  const queenTargeting = useGameStore((s) => s.queenTargeting);
  const dispatchQueen = useGameStore((s) => s.dispatchQueen);

  const queenCost = BEE_STATS.queen.honeyCost;
  const queensFull = activeQueens >= allowance;
  const hiveLargeEnough = tileCount >= QUEEN_MIN_OWNED_HEXES;
  const targeting = queenTargeting !== null;
  const canSpawn = (!queensFull && honey >= queenCost && hiveLargeEnough) || targeting;

  const emptySlots = Math.max(0, allowance - activeQueens);
  const affordableSpawns = Math.floor(honey / queenCost);
  const readyEmptySlots = hiveLargeEnough
    ? Math.min(emptySlots, affordableSpawns)
    : 0;

  const slotState = (index: number): 'in-use' | 'ready' | 'dim' => {
    if (index < activeQueens) return 'in-use';
    if (index < activeQueens + readyEmptySlots) return 'ready';
    return 'dim';
  };

  const readyCount = Math.max(0, readyEmptySlots);
  const slotAriaLabel =
    allowance === 1
      ? `${activeQueens} queen in flight; ${readyCount > 0 ? 'ready to spawn' : 'cannot spawn'}`
      : `${activeQueens} of ${allowance} queens in flight; ${readyCount} slot${readyCount === 1 ? '' : 's'} ready`;

  return (
    <div className="queen-spawn-bar">
      <button
        type="button"
        className="queen-spawn-button"
        disabled={!canSpawn}
        data-active={queensFull || !hiveLargeEnough || targeting}
        data-targeting={targeting || undefined}
        onClick={() => dispatchQueen('self')}
      >
        <span className="queen-spawn-crown" aria-hidden>
          👑
        </span>
        <span className="queen-spawn-text">
          <span className="queen-spawn-label">SPAWN QUEEN</span>
          <span className="queen-spawn-cost">
            {queenCost}🜨
          </span>
        </span>
      </button>
      <div className="queen-slot-strip" role="img" aria-label={slotAriaLabel}>
        {Array.from({ length: allowance }, (_, i) => (
          <span
            key={i}
            className="queen-slot-icon"
            data-state={slotState(i)}
            aria-hidden
          >
            <QueenBeeIcon className="queen-slot-bee" />
          </span>
        ))}
      </div>
    </div>
  );
};
