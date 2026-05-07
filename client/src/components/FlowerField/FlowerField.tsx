/**
 * Renders the central flower field. Each `FlowerPatch` is one of three types
 * (vowel / common / rare) and shows up as a 6-petal arrangement around its
 * (unused) center hex. Petals fall off as they wither — by the time a petal's
 * `witherAt` is close to engine-time it visibly fades and shrinks. Players
 * tap any petal to queue its hex for their next worker.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  axialToPixel,
  hex,
  hexEquals,
  hexKey,
  range,
  type FlowerPatch,
  type FlowerType,
  type Hex,
  type Petal,
} from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { FIELD_RADIUS } from '../../game/engine/state.js';
import {
  centeredViewBoxExtent,
  registerGrid,
  unregisterGrid,
} from '../../game/layout.js';

const HEX_SIZE = 26;

const hexPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

const queueIndex = (queue: readonly Hex[], h: Hex): number =>
  queue.findIndex((q) => hexEquals(q, h));

const TYPE_LABEL: Record<FlowerType, string> = {
  vowel: 'VOWEL',
  common: 'COMMON',
  rare: 'RARE',
};

/** Returns 0..1 wither factor: 0 = fresh, 1 = about to drop. */
const witherFactor = (petal: Petal, t: number): number => {
  const window = 4; // start fading 4s before drop
  const remaining = petal.witherAt - t;
  if (remaining >= window) return 0;
  if (remaining <= 0) return 1;
  return 1 - remaining / window;
};

export const FlowerField = () => {
  const patches = useGameStore((s) => s.world.patches);
  const engineT = useGameStore((s) => s.world.t);
  const selfQueue = useGameStore((s) => s.world.self.letterQueue);
  const oppQueue = useGameStore((s) => s.world.opponent.letterQueue);
  const toggleQueue = useGameStore((s) => s.toggleLetterQueue);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const allTiles = useMemo(() => range(hex(0, 0), FIELD_RADIUS), []);

  // Force a re-render between engine ticks so wither animations stay smooth.
  const [, force] = useState(0);
  const rafRef = useRef(0);
  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) % 1024);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const extent = useMemo(
    () => centeredViewBoxExtent(allTiles, HEX_SIZE),
    [allTiles],
  );
  const viewBox = `${-extent.halfWidth} ${-extent.halfHeight} ${extent.halfWidth * 2} ${extent.halfHeight * 2}`;

  useEffect(() => {
    registerGrid('flowers', {
      el: svgRef.current,
      viewBoxHalfWidth: extent.halfWidth,
      viewBoxHalfHeight: extent.halfHeight,
      hexSize: HEX_SIZE,
    });
    return () => unregisterGrid('flowers');
  }, [extent.halfWidth, extent.halfHeight]);

  return (
    <div className="grid-frame">
      <h2 className="hud-title grid-heading">FLOWER FIELD</h2>
      <p className="grid-subtitle">tap a petal to queue it · 3 patches · withering</p>
      <svg
        ref={svgRef}
        className="hex-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="flower field"
        style={{ touchAction: 'manipulation' }}
      >
        {patches.map((patch: FlowerPatch) => {
          const cp = axialToPixel(patch.center, HEX_SIZE);
          return (
            <g key={patch.id} className="flower-patch" data-type={patch.type}>
              <g transform={`translate(${cp.x},${cp.y})`}>
                <path
                  d={hexPath(HEX_SIZE * 0.55)}
                  className="flower-center"
                  data-type={patch.type}
                />
                <text className="flower-center-label" x={0} y={0}>
                  {TYPE_LABEL[patch.type]}
                </text>
              </g>
              {patch.petals.map((petal) => {
                const pp = axialToPixel(petal.hex, HEX_SIZE);
                const w = witherFactor(petal, engineT);
                const selfIdx = queueIndex(selfQueue, petal.hex);
                const oppIdx = queueIndex(oppQueue, petal.hex);
                const queuedSelf = selfIdx >= 0;
                const queuedOpp = oppIdx >= 0;
                const scale = 1 - w * 0.35;
                const k = `${patch.id}-${hexKey(petal.hex)}`;
                return (
                  <g
                    key={k}
                    transform={`translate(${pp.x},${pp.y}) scale(${scale.toFixed(3)})`}
                    className="flower-petal"
                    data-type={patch.type}
                    data-withering={w > 0.001}
                    style={{ opacity: 1 - w * 0.55, cursor: 'pointer' }}
                    onClick={() => toggleQueue(petal.hex)}
                  >
                    <path
                      d={hexPath(HEX_SIZE * 0.92)}
                      className="petal-tile"
                      data-type={patch.type}
                      data-queued-self={queuedSelf}
                      data-queued-opp={queuedOpp}
                    />
                    <text className="hex-letter petal-letter" x={0} y={0}>
                      {petal.letter}
                    </text>
                    {queuedSelf && (
                      <g className="flower-badge flower-badge-self">
                        <circle r={8} cx={HEX_SIZE * 0.55} cy={-HEX_SIZE * 0.55} />
                        <text x={HEX_SIZE * 0.55} y={-HEX_SIZE * 0.55}>{selfIdx + 1}</text>
                      </g>
                    )}
                    {queuedOpp && (
                      <g className="flower-badge flower-badge-opp">
                        <circle r={8} cx={-HEX_SIZE * 0.55} cy={-HEX_SIZE * 0.55} />
                        <text x={-HEX_SIZE * 0.55} y={-HEX_SIZE * 0.55}>{oppIdx + 1}</text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
