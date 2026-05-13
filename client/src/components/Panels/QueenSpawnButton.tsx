/**
 * Big, conspicuous gold button anchored just under the panel-navigation tabs.
 * Clicking it begins the queen flow: the rival mini-board expands so you pick
 * a side (top / right / bottom / left). The engine lands on the outermost hex
 * on that edge. If no side is chosen before the timer, the queen auto-fires.
 *
 * Disabled when the hive has fewer than {@link QUEEN_MIN_OWNED_HEXES} owned
 * hexes, when the player's queen allowance is full (one queen plus one extra
 * per multiple of `HEXES_PER_QUEEN_SLOT` owned hexes), or when honey is below
 * the queen's cost.
 */

import { useEffect, useState } from 'react';
import {
  activeQueenCountFor,
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
  queenAllowanceFor,
} from '@hivemind/shared';
import { QUEEN_TARGETING_MS, useGameStore } from '../../state/gameStore.js';

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
  // While targeting we still let the user click the button — it cancels.
  const canSpawn = (!queensFull && honey >= queenCost && hiveLargeEnough) || targeting;
  const showCounter = allowance > 1 || activeQueens > 0;
  const slotSuffix = showCounter ? ` (${activeQueens}/${allowance})` : '';

  // Tick a countdown while targeting so the label visibly counts down.
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!targeting) return;
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, [targeting]);
  const remainingMs = queenTargeting
    ? Math.max(0, queenTargeting.deadline - now)
    : QUEEN_TARGETING_MS;
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  const label = targeting
    ? `PICK A TARGET — ${remainingSeconds}s${slotSuffix}`
    : queensFull
      ? `QUEENS DEPLOYED${slotSuffix}`
      : !hiveLargeEnough
        ? `SPAWN QUEEN — ${tileCount}/${QUEEN_MIN_OWNED_HEXES} hexes${slotSuffix}`
        : honey < queenCost
          ? `SPAWN QUEEN — ${Math.floor(honey)}/${queenCost}🜨${slotSuffix}`
          : `SPAWN QUEEN${slotSuffix}`;

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
        <span className="queen-spawn-label">{label}</span>
        <span className="queen-spawn-cost" aria-hidden>
          {queenCost}🜨
        </span>
      </button>
    </div>
  );
};
