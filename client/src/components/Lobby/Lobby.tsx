import { useEffect, useState } from 'react';
import { useGameStore } from '../../state/gameStore.js';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting…',
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

const ChooseRoom = () => {
  const status = useGameStore((s) => s.net.status);
  const createRoom = useGameStore((s) => s.createRoom);
  const joinRoom = useGameStore((s) => s.joinRoom);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  // Under the Cloudflare backend the WS only opens after the user picks
  // create-or-join, so the buttons are gated on having a name (and a valid
  // code for join), not on a pre-existing socket. While a request is in
  // flight `status === 'connecting'`, so we lock the buttons to prevent
  // double-fires.
  const busy = status === 'connecting';
  const ready = !busy && name.trim().length > 0;

  return (
    <div className="lobby-card">
      <h2 className="hud-title">MULTIPLAYER</h2>
      <label className="lobby-field">
        <span>NAME</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder="bee keeper"
          maxLength={16}
        />
      </label>
      <div className="lobby-actions">
        <button
          type="button"
          className="lobby-button"
          onClick={() => createRoom(name.trim() || 'host')}
          disabled={!ready}
        >
          CREATE ROOM
        </button>
        <div className="lobby-divider">— or —</div>
        <label className="lobby-field">
          <span>JOIN CODE</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            maxLength={6}
          />
        </label>
        <button
          type="button"
          className="lobby-button"
          onClick={() => joinRoom(code.trim().toUpperCase(), name.trim() || 'guest')}
          disabled={!ready || code.trim().length !== 6}
        >
          JOIN ROOM
        </button>
      </div>
    </div>
  );
};

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
        // last-ditch silent failure — the code is still readable on screen.
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
  const opponentPresent = room.players.length === 2;
  const everyoneReady = opponentPresent && room.players.every((p) => p.ready);

  // Optimistically mark our own ready button as pressed once we send. The
  // server will echo back a ROOM_STATE that confirms.
  return (
    <div className="lobby-card">
      <RoomCodeHeading code={room.code} />
      <div className="lobby-roster">
        {[0, 1].map((i) => {
          const p = room.players[i];
          if (!p) {
            return (
              <div key={i} className="lobby-roster-row" data-empty="true">
                <span>…</span>
                <span>waiting for opponent</span>
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
          disabled={haveSentReady || !opponentPresent}
        >
          {haveSentReady ? (everyoneReady ? 'STARTING…' : 'WAITING…') : 'READY'}
        </button>
      </div>
    </div>
  );
};

export const Lobby = () => {
  const enterLobby = useGameStore((s) => s.enterLobby);
  const leaveLobby = useGameStore((s) => s.leaveLobby);
  const room = useGameStore((s) => s.room);

  useEffect(() => {
    enterLobby();
  }, [enterLobby]);

  return (
    <div className="lobby" role="dialog" aria-modal="true">
      <div className="lobby-shell">
        {room ? <WaitingRoom /> : <ChooseRoom />}
        <StatusLine />
        <button
          type="button"
          className="lobby-button lobby-button-ghost"
          onClick={leaveLobby}
        >
          BACK TO SOLO
        </button>
      </div>
    </div>
  );
};
