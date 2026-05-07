import { useGameStore } from '../../state/gameStore.js';

export const GameOver = () => {
  const phase = useGameStore((s) => s.world.phase);
  const winner = useGameStore((s) => s.world.winner);
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const initSolo = useGameStore((s) => s.initSolo);
  const room = useGameStore((s) => s.room);
  const leaveLobby = useGameStore((s) => s.leaveLobby);
  const mode = useGameStore((s) => s.mode);

  // In online mode prefer the server's verdict (which is named per-player and
  // includes the reason); fall back to engine state for solo.
  const onlineResult = room?.result ?? null;
  const isOver = onlineResult !== null || phase === 'over';
  if (!isOver) return null;

  const wonOnline =
    onlineResult && room
      ? onlineResult.winnerId === room.selfId
      : null;

  const heading = onlineResult
    ? wonOnline === null
      ? 'STALEMATE'
      : wonOnline
        ? 'HIVE TRIUMPHS'
        : 'HIVE FALLS'
    : winner === 'self'
      ? 'HIVE TRIUMPHS'
      : winner === 'opponent'
        ? 'HIVE FALLS'
        : 'STALEMATE';

  const reasonLine = onlineResult
    ? onlineResult.reason === 'forfeit'
      ? 'opponent left the hive'
      : onlineResult.reason === 'queen'
        ? 'queen pierced the throne'
        : 'time expired'
    : null;

  const selfHoney = Math.floor(self.honey);
  const oppHoney = Math.floor(opponent.honey);

  const handleClick = () => {
    if (mode === 'online') {
      leaveLobby();
    } else {
      initSolo();
    }
  };

  return (
    <div className="game-over" role="alertdialog" aria-modal="true">
      <div className="game-over-card">
        <h2 className="hud-title">{heading}</h2>
        {reasonLine ? <div className="game-over-reason">{reasonLine}</div> : null}
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
        <button type="button" onClick={handleClick}>
          {mode === 'online' ? 'BACK TO SOLO' : 'NEW ROUND'}
        </button>
      </div>
    </div>
  );
};
