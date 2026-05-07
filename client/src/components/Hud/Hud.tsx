import { useGameStore } from '../../state/gameStore.js';
import { ActivityFeed } from './ActivityFeed.js';

const Stat = ({ label, value, accent }: { label: string; value: string | number; accent?: string }) => (
  <div className="hud-stat" data-accent={accent}>
    <span>{label}</span>
    <span>{value}</span>
  </div>
);

const formatClock = (remaining: number): string => {
  const m = Math.max(0, Math.floor(remaining / 60));
  const s = Math.max(0, Math.floor(remaining % 60));
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const Hud = () => {
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const t = useGameStore((s) => s.world.t);

  const remaining = 5 * 60 - t;

  return (
    <header className="hud">
      <div className="hud-cluster">
        <Stat label="HONEY" value={Math.floor(self.honey)} accent="honey" />
        <Stat label="HP" value={self.hp} />
        <Stat label="SCORE" value={self.score} />
      </div>

      <div className="hud-center">
        <div className="hud-title">HIVEMIND</div>
        <div className="hud-clock" aria-label="time remaining">
          {formatClock(remaining)}
        </div>
      </div>

      <div className="hud-cluster hud-cluster-end">
        <Stat label="RIVAL HP" value={opponent.hp} />
        <Stat label="RIVAL" value={opponent.score} />
        <ActivityFeed />
      </div>
    </header>
  );
};
