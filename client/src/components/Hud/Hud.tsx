import { honeyCapFor } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';

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

const formatHoney = (current: number, cap: number): string =>
  `${Math.floor(current)}/${Math.floor(cap)}`;

export const Hud = () => {
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const mode = useGameStore((s) => s.mode);
  const enterLobby = useGameStore((s) => s.enterLobby);
  const leaveLobby = useGameStore((s) => s.leaveLobby);

  const selfCap = honeyCapFor(self);
  const oppCap = honeyCapFor(opponent);

  return (
    <header className="hud">
      <div className="hud-cluster">
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
      </div>
    </header>
  );
};
