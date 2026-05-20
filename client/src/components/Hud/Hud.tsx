import { useGameStore } from '../../state/gameStore.js';

export const Hud = () => {
  const mode = useGameStore((s) => s.mode);
  const enterMenu = useGameStore((s) => s.enterMenu);
  const leaveLobby = useGameStore((s) => s.leaveLobby);

  return (
    <header className="hud">
      <div className="hud-cluster">
        {mode === 'solo' ? (
          <button
            type="button"
            className="hud-net-button"
            onClick={() => enterMenu()}
            aria-label="return to main menu"
          >
            MENU
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
