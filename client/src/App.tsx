import { useEffect } from 'react';
import { PanelDeck } from './components/Panels/PanelDeck.js';
import { PlayerPanel } from './components/Panels/PlayerPanel.js';
import { HiveGrid } from './components/HiveGrid/HiveGrid.js';
import { FlowerField } from './components/FlowerField/FlowerField.js';
import { Hud } from './components/Hud/Hud.js';
import { GameOver } from './components/Hud/GameOver.js';
import { BeeOverlay } from './components/Bee/BeeOverlay.js';
import { DragGhost } from './components/Bee/DragGhost.js';
import { Toasts } from './components/Toasts/Toasts.js';
import { Lobby } from './components/Lobby/Lobby.js';
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

  return (
    <div className="app crt">
      <Hud />
      <PanelDeck>
        <PlayerPanel />
        <FlowerField />
        <HiveGrid side="opponent" />
      </PanelDeck>
      <BeeOverlay />
      <DragGhost />
      <Toasts />
      <GameOver />
      {mode === 'lobby' ? <Lobby /> : null}
      <div className="scanlines" aria-hidden />
    </div>
  );
};
