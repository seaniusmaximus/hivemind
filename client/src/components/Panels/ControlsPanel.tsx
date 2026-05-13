/**
 * Left-side player panel. With the worker / carpenter queues removed there's
 * no list to render — this panel is now a slim cheat sheet for the new
 * hold-to-send gestures and their honey costs. Errors no longer surface here:
 * they pop out of the hex the player just touched (see `<Toasts />`).
 */

import { BEE_STATS, QUEEN_MIN_OWNED_HEXES } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { HOLD_HINT_SECONDS } from '../useHoldToDispatch.js';

export const ControlsPanel = () => {
  const honey = useGameStore((s) => Math.floor(s.world.self.honey));
  const tileCount = useGameStore((s) => s.world.self.tiles.length);
  const workerCost = BEE_STATS.worker.honeyCost;
  const carpenterCost = BEE_STATS.carpenter.honeyCost;
  const queenCost = BEE_STATS.queen.honeyCost;
  const holdSeconds = HOLD_HINT_SECONDS;

  return (
    <div className="controls-panel">
      <h3 className="controls-title">CONTROLS</h3>
      <ul className="controls-list">
        <li className="controls-row">
          <span className="controls-row-label">WORKER</span>
          <span className="controls-row-hint">
            hold a flower {holdSeconds}s
          </span>
          <span className="controls-row-cost" data-affordable={honey >= workerCost}>
            {workerCost}🜨
          </span>
        </li>
        <li className="controls-row">
          <span className="controls-row-label">CARPENTER</span>
          <span className="controls-row-hint">
            hold a frontier tile {holdSeconds}s
          </span>
          <span className="controls-row-cost" data-affordable={honey >= carpenterCost}>
            {carpenterCost}🜨
          </span>
        </li>
        <li className="controls-row">
          <span className="controls-row-label">QUEEN</span>
          <span className="controls-row-hint">click hive or HUD button</span>
          <span className="controls-row-cost" data-affordable={honey >= queenCost && tileCount >= QUEEN_MIN_OWNED_HEXES}>
            {queenCost}🜨
          </span>
        </li>
      </ul>
    </div>
  );
};
