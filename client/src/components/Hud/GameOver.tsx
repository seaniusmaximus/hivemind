import { useEffect, useRef, useState } from 'react';

import { playGameOver } from '../../game/audio/sfx.js';

import { useGameStore } from '../../state/gameStore.js';



const formatBestWord = (word: string, score: number): string =>

  word.length > 0 ? `${word} — ${score} 🜨` : '—';



export const GameOver = () => {

  const phase = useGameStore((s) => s.world.phase);

  const winnerId = useGameStore((s) => s.world.winnerId);
  const self = useGameStore((s) => s.world.self);
  const opponent = useGameStore((s) => s.world.opponent);
  const opponents = useGameStore((s) => s.world.opponents);

  const initSolo = useGameStore((s) => s.initSolo);

  const room = useGameStore((s) => s.room);

  const leaveLobby = useGameStore((s) => s.leaveLobby);

  const sendReady = useGameStore((s) => s.sendReady);

  const mode = useGameStore((s) => s.mode);



  const [rematchClicked, setRematchClicked] = useState(false);

  const [panelHidden, setPanelHidden] = useState(false);



  const onlineResult = room?.result ?? null;

  const isOver = mode === 'online' ? onlineResult !== null : phase === 'over';



  const wonOnline =

    onlineResult && room

      ? onlineResult.winnerId === null

        ? null

        : onlineResult.winnerId === room.selfId

      : null;



  useEffect(() => {

    if (!isOver) {

      setRematchClicked(false);

      setPanelHidden(false);

    }

  }, [isOver]);



  const endStingerPlayed = useRef(false);

  useEffect(() => {

    if (!isOver) {

      endStingerPlayed.current = false;

      return;

    }

    if (endStingerPlayed.current) return;

    endStingerPlayed.current = true;

    let outcome: 'win' | 'lose' | 'draw';

    if (onlineResult && room) {

      if (onlineResult.winnerId === null) outcome = 'draw';

      else outcome = onlineResult.winnerId === room.selfId ? 'win' : 'lose';

    } else if (winnerId === self.id) outcome = 'win';

    else if (winnerId !== null) outcome = 'lose';

    else outcome = 'draw';

    playGameOver(outcome);

  }, [isOver, onlineResult, winnerId, room, self.id]);



  if (!isOver) return null;



  const selfPlayer = room?.players.find((p) => p.id === room.selfId) ?? null;

  const opponentPlayer =
    room?.players.find((p) => p.id !== room.selfId && opponents.some((o) => o.id === p.id)) ??
    null;

  const selfReady = !!selfPlayer?.ready || rematchClicked;

  const opponentReady = !!opponentPlayer?.ready;

  const opponentPresent = !!opponentPlayer;



  const heading = onlineResult

    ? wonOnline === null

      ? 'STALEMATE'

      : wonOnline

        ? 'HIVE TRIUMPHS'

        : 'HIVE FALLS'

    : winnerId === self.id

      ? 'HIVE TRIUMPHS'

      : winnerId !== null

        ? 'HIVE FALLS'

        : 'STALEMATE';



  const reasonLine = onlineResult

    ? onlineResult.reason === 'forfeit'

      ? 'opponent left the hive'

      : 'queen pierced the throne'

    : null;



  const canRematch = mode === 'online' && (room?.players.length ?? 0) >= 2 && onlineResult?.reason !== 'forfeit';



  const rematchLabel = (room?.players.length ?? 0) < 2

    ? 'WAITING FOR PLAYERS…'

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



  if (panelHidden) {

    return (

      <div className="game-over game-over--minimized" aria-live="polite">

        <div className="game-over-dock">

          <button

            type="button"

            className="game-over-dock-btn"

            onClick={() => setPanelHidden(false)}

          >

            SHOW RESULTS

          </button>

          {canRematch ? (

            <button

              type="button"

              className="game-over-dock-btn game-over-rematch"

              onClick={handleRematch}

              disabled={selfReady}

            >

              {rematchLabel}

            </button>

          ) : null}

          <button type="button" className="game-over-dock-btn" onClick={handlePrimary}>

            {mode === 'online' ? 'LEAVE' : 'NEW ROUND'}

          </button>

        </div>

      </div>

    );

  }



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

        <div className="game-over-best-words">

          <div className="game-over-best-words-title">BEST WORDS</div>

          <div className="game-over-row">

            <span>YOU</span>

            <span>{formatBestWord(self.bestWord, self.bestWordScore)}</span>

          </div>

          <div className="game-over-row">

            <span>RIVAL</span>

            <span>{formatBestWord(opponent.bestWord, opponent.bestWordScore)}</span>

          </div>

        </div>

        <div className="game-over-actions">

          <button

            type="button"

            className="game-over-secondary"

            onClick={() => setPanelHidden(true)}

          >

            VIEW BOARD

          </button>

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


