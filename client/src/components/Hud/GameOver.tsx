import { useGameStore } from '../../state/gameStore.js';

export const GameOver = () => {
  const phase = useGameStore((s) => s.world.phase);
  const winner = useGameStore((s) => s.world.winner);
  const initSolo = useGameStore((s) => s.initSolo);

  if (phase !== 'over') return null;

  const heading =
    winner === 'self' ? 'HIVE TRIUMPHS' : winner === 'opponent' ? 'HIVE FALLS' : 'STALEMATE';

  return (
    <div className="game-over" role="alertdialog" aria-modal="true">
      <div className="game-over-card">
        <h2 className="hud-title">{heading}</h2>
        <button type="button" onClick={() => initSolo()}>
          NEW ROUND
        </button>
      </div>
    </div>
  );
};
