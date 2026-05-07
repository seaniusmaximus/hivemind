import { useGameStore } from '../../state/gameStore.js';

export const GameOver = () => {
  const phase = useGameStore((s) => s.world.phase);
  const winner = useGameStore((s) => s.world.winner);
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const initSolo = useGameStore((s) => s.initSolo);

  if (phase !== 'over') return null;

  const heading =
    winner === 'self' ? 'HIVE TRIUMPHS' : winner === 'opponent' ? 'HIVE FALLS' : 'STALEMATE';

  const selfHoney = Math.floor(self.honey);
  const oppHoney = Math.floor(opponent.honey);

  return (
    <div className="game-over" role="alertdialog" aria-modal="true">
      <div className="game-over-card">
        <h2 className="hud-title">{heading}</h2>
        <div className="game-over-tally">
          <div className="game-over-row">
            <span>HIVE</span>
            <span>{selfHoney} 🜨</span>
          </div>
          <div className="game-over-row">
            <span>RIVAL</span>
            <span>{oppHoney} 🜨</span>
          </div>
        </div>
        <button type="button" onClick={() => initSolo()}>
          NEW ROUND
        </button>
      </div>
    </div>
  );
};
