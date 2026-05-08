import { useEffect, useState } from 'react';
import { useGameStore } from '../../state/gameStore.js';

export const GameOver = () => {
  const phase = useGameStore((s) => s.world.phase);
  const winner = useGameStore((s) => s.world.winner);
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const initSolo = useGameStore((s) => s.initSolo);
  const room = useGameStore((s) => s.room);
  const leaveLobby = useGameStore((s) => s.leaveLobby);
  const sendReady = useGameStore((s) => s.sendReady);
  const mode = useGameStore((s) => s.mode);

  // Optimistic flag — the click immediately disables the button so a burst
  // of taps doesn't spam READY. The server echoes our readiness in the next
  // ROOM_STATE, and a fresh GAME_START clears `room.result` so this whole
  // overlay unmounts (which clears the local state via the effect below).
  const [rematchClicked, setRematchClicked] = useState(false);

  // In online mode prefer the server's verdict (which is named per-player and
  // includes the reason); fall back to engine state for solo. Keying online
  // visibility purely off `room.result` avoids a flash between GAME_START
  // and the first SNAPSHOT during a rematch — `world.phase` still reads
  // 'over' until the new snapshot lands, but `result` is cleared eagerly.
  const onlineResult = room?.result ?? null;
  const isOver = mode === 'online' ? onlineResult !== null : phase === 'over';

  // Reset the optimistic flag whenever we leave the game-over screen so a
  // subsequent match starts with a clean slate.
  useEffect(() => {
    if (!isOver) setRematchClicked(false);
  }, [isOver]);

  if (!isOver) return null;

  const selfPlayer = room?.players.find((p) => p.id === room.selfId) ?? null;
  const opponentPlayer = room?.players.find((p) => p.id === room?.opponentId) ?? null;
  const selfReady = !!selfPlayer?.ready || rematchClicked;
  const opponentReady = !!opponentPlayer?.ready;
  const opponentPresent = !!opponentPlayer;

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
      : 'queen pierced the throne'
    : null;

  // Forfeit means the opponent has disconnected — no point offering a rematch
  // until they rejoin (which they can't, the room is on its way down).
  const canRematch = mode === 'online' && opponentPresent && onlineResult?.reason !== 'forfeit';

  const rematchLabel = !opponentPresent
    ? 'WAITING FOR OPPONENT…'
    : selfReady && opponentReady
      ? 'STARTING…'
      : selfReady
        ? 'WAITING FOR OPPONENT…'
        : opponentReady
          ? 'OPPONENT WANTS REMATCH'
          : 'REMATCH';

  const selfHoney = Math.floor(self.honey);
  const oppHoney = Math.floor(opponent.honey);

  const handleRematch = () => {
    if (selfReady) return;
    setRematchClicked(true);
    sendReady();
  };

  const handlePrimary = () => {
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
        <div className="game-over-actions">
          {canRematch ? (
            <button
              type="button"
              className="game-over-rematch"
              onClick={handleRematch}
              disabled={selfReady}
              aria-label="Rematch in same room"
            >
              {rematchLabel}
            </button>
          ) : null}
          <button type="button" onClick={handlePrimary}>
            {mode === 'online' ? 'LEAVE ROOM' : 'NEW ROUND'}
          </button>
        </div>
      </div>
    </div>
  );
};
