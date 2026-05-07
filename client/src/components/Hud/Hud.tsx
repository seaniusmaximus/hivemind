import { honeyCapFor } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { ActivityFeed } from './ActivityFeed.js';

const Stat = ({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) => (
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

const formatHoney = (current: number, cap: number): string =>
  `${Math.floor(current)}/${Math.floor(cap)}`;

export const Hud = () => {
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const t = useGameStore((s) => s.world.t);
  const mode = useGameStore((s) => s.mode);
  const enterLobby = useGameStore((s) => s.enterLobby);
  const leaveLobby = useGameStore((s) => s.leaveLobby);

  const remaining = 5 * 60 - t;
  const selfCap = honeyCapFor(self);
  const oppCap = honeyCapFor(opponent);

  return (
    <header className="hud">
      <div className="hud-cluster">
        <Stat label="HONEY" value={formatHoney(self.honey, selfCap)} accent="honey" />
        {mode === 'solo' ? (
          <button
            type="button"
            className="hud-net-button"
            onClick={() => enterLobby()}
            aria-label="open multiplayer lobby"
          >
            ONLINE
          </button>
        ) : (
          <button
            type="button"
            className="hud-net-button hud-net-button-active"
            onClick={() => leaveLobby()}
            aria-label="leave multiplayer"
          >
            LEAVE
          </button>
        )}
      </div>

      <div className="hud-center">
        <div className="hud-title">HIVEMIND</div>
        <div className="hud-clock" aria-label="time remaining">
          {formatClock(remaining)}
        </div>
      </div>

      <div className="hud-cluster hud-cluster-end">
        <Stat label="RIVAL" value={formatHoney(opponent.honey, oppCap)} />
        <ActivityFeed />
      </div>
    </header>
  );
};
