import { honeyCapFor } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { HiveGrid } from '../HiveGrid/HiveGrid.js';
import { ControlsPanel } from './ControlsPanel.js';
import { OpponentBoardMini } from './OpponentBoardMini.js';

const SelfHiveHoneyLabel = () => {
  const self = useGameStore((s) => s.world.self);
  const current = Math.floor(self.honey);
  const cap = honeyCapFor(self);
  return (
    <p
      className="player-panel-honey-label"
      aria-label={`Honey ${current} of ${cap}`}
    >
      {current}/{cap}🜨
    </p>
  );
};

/**
 * Player-facing panel: hex grid centered with control sidebars in the empty
 * space around it. The "empty ring" the design calls for is partly visual
 * (the ring-1 hexes aren't rendered, leaving a gap around the central hive
 * tile) and partly literal (these flanking sidebars).
 */
export const PlayerPanel = () => {
  return (
    <div className="player-panel">
      <aside className="player-panel-side player-panel-left">
        <ControlsPanel />
      </aside>
      <div className="player-panel-grid">
        <HiveGrid side="self" honeyLabel={<SelfHiveHoneyLabel />} />
      </div>
      <aside className="player-panel-side player-panel-right">
        <OpponentBoardMini />
      </aside>
    </div>
  );
};
