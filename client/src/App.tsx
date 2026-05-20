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
import { Toasts } from './components/Toasts/Toasts.js';
import { Lobby } from './components/Lobby/Lobby.js';
import { StartScreen } from './components/Menu/StartScreen.js';
import { resumeSfxContext } from './game/audio/sfx.js';
import { startLoop } from './game/engine/loop.js';
import { useGameStore } from './state/gameStore.js';

export const App = () => {
  const tick = useGameStore((s) => s.tick);
  const mode = useGameStore((s) => s.mode);

  useEffect(() => {
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

  if (mode === 'menu') {
    return (
      <div className="app crt">
        <StartScreen />
        <div className="scanlines" aria-hidden />
      </div>
    );
  }

  if (mode === 'lobby') {
    return (
      <div className="app crt">
        <Lobby />
        <div className="scanlines" aria-hidden />
      </div>
    );
  }

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
      <Toasts />
      <GameOver />
      <div className="scanlines" aria-hidden />
    </div>
  );
};
