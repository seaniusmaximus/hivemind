import { useEffect } from 'react';
import { PanelDeck } from './components/Panels/PanelDeck.js';
import { PlayerPanel } from './components/Panels/PlayerPanel.js';
import { HiveGrid } from './components/HiveGrid/HiveGrid.js';
import { FlowerField } from './components/FlowerField/FlowerField.js';
import { Hud } from './components/Hud/Hud.js';
import { DebugHud } from './components/Hud/DebugHud.js';
import { GameOver } from './components/Hud/GameOver.js';
import { BeeOverlay } from './components/Bee/BeeOverlay.js';
import { DragGhost } from './components/Bee/DragGhost.js';
import { IncomingQueenWatcher } from './components/Toasts/IncomingQueenWatcher.js';
import { WordCapHoneyWatcher } from './components/Toasts/WordCapHoneyWatcher.js';
import { Toasts } from './components/Toasts/Toasts.js';
import { Lobby } from './components/Lobby/Lobby.js';
import { resumeSfxContext } from './game/audio/sfx.js';
import { startLoop } from './game/engine/loop.js';
import { useGameStore } from './state/gameStore.js';

export const App = () => {
  const initSolo = useGameStore((s) => s.initSolo);
  const tick = useGameStore((s) => s.tick);
  const mode = useGameStore((s) => s.mode);

  useEffect(() => {
    initSolo();
  }, [initSolo]);

  useEffect(() => {
    // The loop runs in every mode — `tick` itself becomes a no-op when the
    // store is in `'online'` mode, so we don't need to gate the rAF here.
    return startLoop({ hz: 30, onTick: (dt) => tick(dt) });
  }, [tick]);

  useEffect(() => {
    const unlock = () => {
      void resumeSfxContext();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  return (
    <div className="app crt">
      <Hud />
      <DebugHud />
      <PanelDeck>
        <PlayerPanel />
        <FlowerField />
        <HiveGrid side="opponent" />
      </PanelDeck>
      <BeeOverlay />
      <DragGhost />
      <IncomingQueenWatcher />
      <WordCapHoneyWatcher />
      <Toasts />
      <GameOver />
      {mode === 'lobby' ? <Lobby /> : null}
      <div className="scanlines" aria-hidden />
    </div>
  );
};
