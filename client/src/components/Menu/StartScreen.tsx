import { playLobbyUi } from '../../game/audio/sfx.js';
import { AI_DIFFICULTIES, type AiDifficulty } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { MultiplayerChooseRoom } from './MultiplayerChooseRoom.js';

const DIFFICULTY_LABEL: Record<AiDifficulty, string> = {
  easy: 'EASY',
  medium: 'MEDIUM',
  hard: 'HARD',
};

export const StartScreen = () => {
  const soloDifficulty = useGameStore((s) => s.soloDifficulty);
  const setSoloDifficulty = useGameStore((s) => s.setSoloDifficulty);
  const startSolo = useGameStore((s) => s.startSolo);
  const netStatus = useGameStore((s) => s.net.status);
  const lastError = useGameStore((s) => s.net.lastError);

  return (
    <div className="start-screen" role="main">
      <div className="start-screen-shell">
        <h1 className="start-screen-title hud-title">HIVEMIND</h1>
        <p className="start-screen-tagline">spell the hive · rule the comb</p>

        <section className="menu-card" aria-labelledby="solo-heading">
          <h2 id="solo-heading" className="menu-card-heading">
            SINGLE PLAYER
          </h2>
          <fieldset className="menu-difficulty">
            <legend className="menu-difficulty-legend">AI DIFFICULTY</legend>
            <div className="menu-difficulty-options" role="radiogroup" aria-label="AI difficulty">
              {AI_DIFFICULTIES.map((level) => (
                <label key={level} className="menu-difficulty-option">
                  <input
                    type="radio"
                    name="ai-difficulty"
                    value={level}
                    checked={soloDifficulty === level}
                    onChange={() => setSoloDifficulty(level)}
                  />
                  <span>{DIFFICULTY_LABEL[level]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className="lobby-button lobby-button-primary menu-play-button"
            onClick={() => {
              playLobbyUi();
              startSolo();
            }}
          >
            PLAY
          </button>
        </section>

        <section className="menu-card" aria-labelledby="multi-heading">
          <h2 id="multi-heading" className="menu-card-heading">
            MULTIPLAYER
          </h2>
          <MultiplayerChooseRoom />
          {netStatus !== 'idle' ? (
            <div className="lobby-status menu-net-status" data-status={netStatus}>
              <span>NET: {netStatus}</span>
              {lastError ? <span className="lobby-status-error">{lastError}</span> : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
