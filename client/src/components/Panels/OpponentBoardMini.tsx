import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  axialToPixel,
  hexKey,
  type QueenAttackSide,
  type TileSnapshot,
} from '@hivemind/shared';
import { centeredViewBoxExtent } from '../../game/layout.js';
import { useGameStore } from '../../state/gameStore.js';

const MINI_HEX = 3.4;
const EXPAND_HEX = 22;

/** Pointy-top hex path centered at origin (same convention as the main hive SVG). */
const hexPathD = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

const RivalBoardSvg = ({
  tiles,
  hexSize,
  className,
  incomingQueenHexKeys,
}: {
  readonly tiles: readonly TileSnapshot[];
  readonly hexSize: number;
  readonly className: string;
  readonly incomingQueenHexKeys: ReadonlySet<string>;
}) => {
  const { vbW, vbH, paths } = useMemo(() => {
    const hexes = tiles.map((t) => t.hex);
    const { halfWidth, halfHeight } = centeredViewBoxExtent(hexes, hexSize);
    const pathsInner = tiles.map((t) => {
      const { x, y } = axialToPixel(t.hex, hexSize);
      const k = hexKey(t.hex);
      const capped = t.state === 'capped';
      const incomingQueen = incomingQueenHexKeys.has(k);
      return { key: k, x, y, capped, incomingQueen };
    });
    return { vbW: halfWidth * 2, vbH: halfHeight * 2, paths: pathsInner };
  }, [tiles, hexSize, incomingQueenHexKeys]);

  const d = hexPathD(hexSize);

  return (
    <svg
      className={className}
      viewBox={`${-vbW / 2} ${-vbH / 2} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {paths.map((p) => (
        <path
          key={p.key}
          d={d}
          transform={`translate(${p.x.toFixed(3)},${p.y.toFixed(3)})`}
          className={[
            'rival-mini-hex',
            p.capped ? 'rival-mini-hex--capped' : '',
            p.incomingQueen ? 'rival-mini-hex--incoming-queen' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        />
      ))}
    </svg>
  );
};

const SIDE_LABEL: Record<QueenAttackSide, string> = {
  top: 'TOP',
  right: 'RIGHT',
  bottom: 'BOTTOM',
  left: 'LEFT',
};

export const OpponentBoardMini = () => {
  const tiles = useGameStore((s) => s.world.opponent.tiles);
  const selfBees = useGameStore((s) => s.world.self.bees);
  const incomingQueenHexKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const b of selfBees) {
      if (b.kind === 'queen' && b.state.kind === 'queen-flying') {
        keys.add(hexKey(b.state.landingHex));
      }
    }
    return keys;
  }, [selfBees]);
  const rivalHoney = useGameStore((s) => Math.floor(s.world.opponent.honey));
  const queenTargeting = useGameStore((s) => s.queenTargeting);
  const confirmQueenAttackSide = useGameStore((s) => s.confirmQueenAttackSide);
  const cancelQueenTargeting = useGameStore((s) => s.cancelQueenTargeting);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const onSide = useCallback(
    (side: QueenAttackSide) => {
      confirmQueenAttackSide(side);
    },
    [confirmQueenAttackSide],
  );

  const expandUi =
    queenTargeting &&
    mounted &&
    createPortal(
      <div
        className="rival-queen-expand-root"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rival-queen-expand-title"
      >
        <button
          type="button"
          className="rival-queen-expand-backdrop"
          aria-label="Cancel queen attack"
          onClick={() => cancelQueenTargeting()}
        />
        <div className="rival-queen-expand-modal">
          <h3 id="rival-queen-expand-title" className="rival-queen-expand-title">
            Choose attack side
          </h3>
          <p className="rival-queen-expand-hint">
            The queen strikes the outermost hex on that edge of the rival hive.
          </p>
          <div className="rival-queen-expand-grid">
            <div className="rival-queen-expand-cell rival-queen-expand-cell--top">
              <button
                type="button"
                className="rival-queen-side-btn"
                onClick={() => onSide('top')}
              >
                {SIDE_LABEL.top}
              </button>
            </div>
            <div className="rival-queen-expand-cell rival-queen-expand-cell--mid">
              <button
                type="button"
                className="rival-queen-side-btn rival-queen-side-btn--compact"
                onClick={() => onSide('left')}
              >
                {SIDE_LABEL.left}
              </button>
              <div className="rival-queen-expand-svg-wrap">
                <RivalBoardSvg
                  tiles={tiles}
                  hexSize={EXPAND_HEX}
                  className="rival-board-expand-svg"
                  incomingQueenHexKeys={incomingQueenHexKeys}
                />
              </div>
              <button
                type="button"
                className="rival-queen-side-btn rival-queen-side-btn--compact"
                onClick={() => onSide('right')}
              >
                {SIDE_LABEL.right}
              </button>
            </div>
            <div className="rival-queen-expand-cell rival-queen-expand-cell--bottom">
              <button
                type="button"
                className="rival-queen-side-btn"
                onClick={() => onSide('bottom')}
              >
                {SIDE_LABEL.bottom}
              </button>
            </div>
          </div>
          <button type="button" className="rival-queen-expand-cancel ghost" onClick={() => cancelQueenTargeting()}>
            Cancel
          </button>
        </div>
      </div>,
      document.body,
    );

  useEffect(() => {
    if (!queenTargeting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelQueenTargeting();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queenTargeting, cancelQueenTargeting]);

  return (
    <div className="rival-board-mini" aria-label="Rival hive layout: gold is capped comb">
      <div className="rival-board-mini-header">
        <span className="rival-board-mini-label">Rival hive</span>
        <span className="rival-board-mini-honey" aria-label={`Rival honey ${rivalHoney}`}>
          {rivalHoney}🜨
        </span>
      </div>
      <RivalBoardSvg
        tiles={tiles}
        hexSize={MINI_HEX}
        className="rival-board-mini-svg"
        incomingQueenHexKeys={incomingQueenHexKeys}
      />
      {expandUi}
    </div>
  );
};
