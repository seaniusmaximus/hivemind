import { honeyCapFor } from '@hivemind/shared';
import { useEffect } from 'react';
import { useGameStore } from '../../state/gameStore.js';

const HONEY_STEPS = [25, 5, -5, -25] as const;

/**
 * Testing helpers: press **`** (backtick) to toggle, **`?debug=1`** in the URL
 * to open on load, **Esc** to close. Queens / honey tweaks run only in **solo**
 * mode so multiplayer stays authoritative.
 */
export const DebugHud = () => {
  const debugMode = useGameStore((s) => s.debugMode);
  const toggleDebugMode = useGameStore((s) => s.toggleDebugMode);
  const mode = useGameStore((s) => s.mode);
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const selfHoney = self.honey;
  const oppHoney = opponent.honey;
  const selfCap = honeyCapFor(self);
  const oppCap = honeyCapFor(opponent);
  const spawnQueen = useGameStore((s) => s.debugSpawnQueen);
  const adjustHoney = useGameStore((s) => s.debugAdjustHoney);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') {
      useGameStore.setState({ debugMode: true });
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Backquote' && !e.repeat) {
        e.preventDefault();
        toggleDebugMode();
      }
      if (e.key === 'Escape' && debugMode) {
        toggleDebugMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDebugMode, debugMode]);

  if (!debugMode) return null;

  const solo = mode === 'solo';

  return (
    <div className="debug-hud" role="dialog" aria-label="Debug panel">
      <div className="debug-hud-header">
        <span className="debug-hud-title">DEBUG</span>
        <span className="debug-hud-meta">{solo ? 'solo' : mode}</span>
        <button type="button" className="debug-hud-close" onClick={() => toggleDebugMode()} aria-label="Close debug panel">
          ×
        </button>
      </div>
      {!solo ? (
        <p className="debug-hud-note">Switch to solo for queen / honey tools.</p>
      ) : (
        <>
          <div className="debug-hud-section">
            <div className="debug-hud-label">Queen (auto landing hex)</div>
            <div className="debug-hud-row">
              <button type="button" onClick={() => spawnQueen('towardRival')}>
                → rival hive
              </button>
              <button type="button" onClick={() => spawnQueen('towardSelf')}>
                → my hive
              </button>
            </div>
          </div>
          <div className="debug-hud-section">
            <div className="debug-hud-label">
              Honey self <span className="debug-hud-val">{Math.floor(selfHoney)}/{Math.floor(selfCap)}</span>
            </div>
            <div className="debug-hud-row debug-hud-row-honey">
              {HONEY_STEPS.map((d) => (
                <button key={`self-${d}`} type="button" onClick={() => adjustHoney('self', d)}>
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </div>
            <div className="debug-hud-label">
              Honey rival <span className="debug-hud-val">{Math.floor(oppHoney)}/{Math.floor(oppCap)}</span>
            </div>
            <div className="debug-hud-row debug-hud-row-honey">
              {HONEY_STEPS.map((d) => (
                <button key={`opp-${d}`} type="button" onClick={() => adjustHoney('opponent', d)}>
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <p className="debug-hud-hint">` toggle · Esc close · ?debug=1</p>
    </div>
  );
};
