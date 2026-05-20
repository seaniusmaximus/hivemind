import { useState } from 'react';
import { playLobbyUi } from '../../game/audio/sfx.js';
import { useGameStore } from '../../state/gameStore.js';

/** Create / join room form — used on the title screen and in the lobby fallback. */
export const MultiplayerChooseRoom = () => {
  const status = useGameStore((s) => s.net.status);
  const enterLobby = useGameStore((s) => s.enterLobby);
  const createRoom = useGameStore((s) => s.createRoom);
  const joinRoom = useGameStore((s) => s.joinRoom);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const busy = status === 'connecting';
  const ready = !busy && name.trim().length > 0;

  return (
    <div className="lobby-actions">
      <label className="lobby-field">
        <span>NAME</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder="bee keeper"
          maxLength={16}
        />
      </label>
      <button
        type="button"
        className="lobby-button"
        onClick={() => {
          playLobbyUi();
          enterLobby();
          void createRoom(name.trim() || 'host');
        }}
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
        onClick={() => {
          playLobbyUi();
          enterLobby();
          joinRoom(code.trim().toUpperCase(), name.trim() || 'guest');
        }}
        disabled={!ready || code.trim().length !== 6}
      >
        JOIN ROOM
      </button>
    </div>
  );
};
