import { useState } from 'react';
import { useGameStore } from '../../state/gameStore.js';
import { MultiplayerChooseRoom } from '../Menu/MultiplayerChooseRoom.js';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting...',
  open: 'connected',
  closed: 'disconnected',
  error: 'connection error',
};

const StatusLine = () => {
  const status = useGameStore((s) => s.net.status);
  const lastError = useGameStore((s) => s.net.lastError);
  return (
    <div className="lobby-status" data-status={status}>
      <span>NET: {STATUS_LABEL[status] ?? status}</span>
      {lastError ? <span className="lobby-status-error">{lastError}</span> : null}
    </div>
  );
};

const LobbyChooseRoom = () => (
  <div className="lobby-card">
    <h2 className="hud-title">MULTIPLAYER</h2>
    <MultiplayerChooseRoom />
  </div>
);

const RoomCodeHeading = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!code) return;
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch {
        // silent
      }
    };
    const onSuccess = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(onSuccess, () => {
        fallback();
        onSuccess();
      });
    } else {
      fallback();
      onSuccess();
    }
  };

  return (
    <div className="room-code-heading">
      <h2 className="hud-title">ROOM {code}</h2>
      <button
        type="button"
        className="lobby-button lobby-button-ghost room-code-copy"
        onClick={handleCopy}
        aria-label="Copy room code to clipboard"
        disabled={!code}
      >
        {copied ? 'COPIED!' : 'COPY CODE'}
      </button>
    </div>
  );
};

const WaitingRoom = () => {
  const room = useGameStore((s) => s.room)!;
  const sendReady = useGameStore((s) => s.sendReady);
  const [haveSentReady, setHaveSentReady] = useState(false);
  const enoughPlayers = room.players.length >= 2;
  const everyoneReady = enoughPlayers && room.players.every((p) => p.ready);

  return (
    <div className="lobby-card">
      <RoomCodeHeading code={room.code} />
      <p className="lobby-hint">
        {room.players.length}/4 players — game starts when all connected players are ready.
      </p>
      <div className="lobby-roster">
        {[0, 1, 2, 3].map((i) => {
          const p = room.players[i];
          if (!p) {
            return (
              <div key={i} className="lobby-roster-row" data-empty="true">
                <span>Slot {i + 1}</span>
                <span>waiting for player</span>
              </div>
            );
          }
          return (
            <div key={p.id} className="lobby-roster-row" data-ready={p.ready}>
              <span>{p.name}</span>
              <span>{p.ready ? 'READY' : 'not ready'}</span>
            </div>
          );
        })}
      </div>
      <div className="lobby-actions">
        <button
          type="button"
          className="lobby-button lobby-button-primary"
          onClick={() => {
            setHaveSentReady(true);
            sendReady();
          }}
          disabled={haveSentReady || !enoughPlayers}
        >
          {haveSentReady ? (everyoneReady ? 'STARTING...' : 'WAITING...') : 'READY'}
        </button>
      </div>
    </div>
  );
};

export const Lobby = () => {
  const leaveLobby = useGameStore((s) => s.leaveLobby);
  const room = useGameStore((s) => s.room);

  return (
    <div className="lobby" role="dialog" aria-modal="true">
      <div className="lobby-shell">
        {room ? <WaitingRoom /> : <LobbyChooseRoom />}
        <StatusLine />
        <button
          type="button"
          className="lobby-button lobby-button-ghost"
          onClick={leaveLobby}
        >
          BACK TO MENU
        </button>
      </div>
    </div>
  );
};
