import { HiveGrid } from '../HiveGrid/HiveGrid.js';
import { QueuePanel } from './QueuePanel.js';
import { WordBuilderPanel } from './WordBuilderPanel.js';

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
        <QueuePanel />
      </aside>
      <div className="player-panel-grid">
        <HiveGrid side="self" />
      </div>
      <aside className="player-panel-side player-panel-right">
        <WordBuilderPanel />
      </aside>
    </div>
  );
};
