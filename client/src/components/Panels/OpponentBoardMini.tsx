import { useMemo } from 'react';
import { axialToPixel, hexKey } from '@hivemind/shared';
import { centeredViewBoxExtent } from '../../game/layout.js';
import { useGameStore } from '../../state/gameStore.js';

const MINI_HEX = 3.4;

/** Pointy-top hex path centered at origin (same convention as the main hive SVG). */
const hexPathD = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

const MINI_PATH = hexPathD(MINI_HEX);

export const OpponentBoardMini = () => {
  const tiles = useGameStore((s) => s.world.opponent.tiles);
  const rivalHoney = useGameStore((s) => Math.floor(s.world.opponent.honey));

  const { vbW, vbH, paths } = useMemo(() => {
    const hexes = tiles.map((t) => t.hex);
    const { halfWidth, halfHeight } = centeredViewBoxExtent(hexes, MINI_HEX);
    const pathsInner = tiles.map((t) => {
      const { x, y } = axialToPixel(t.hex, MINI_HEX);
      const capped = t.state === 'capped';
      return { key: hexKey(t.hex), x, y, capped };
    });
    return { vbW: halfWidth * 2, vbH: halfHeight * 2, paths: pathsInner };
  }, [tiles]);

  return (
    <div className="rival-board-mini" aria-label="Rival hive layout: gold is capped comb">
      <div className="rival-board-mini-header">
        <span className="rival-board-mini-label">Rival hive</span>
        <span className="rival-board-mini-honey" aria-label={`Rival honey ${rivalHoney}`}>
          {rivalHoney}🜨
        </span>
      </div>
      <svg
        className="rival-board-mini-svg"
        viewBox={`${-vbW / 2} ${-vbH / 2} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        {paths.map((p) => (
          <path
            key={p.key}
            d={MINI_PATH}
            transform={`translate(${p.x.toFixed(3)},${p.y.toFixed(3)})`}
            className={p.capped ? 'rival-mini-hex rival-mini-hex--capped' : 'rival-mini-hex'}
          />
        ))}
      </svg>
    </div>
  );
};
