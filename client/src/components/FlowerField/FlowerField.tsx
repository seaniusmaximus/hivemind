/**
 * Renders the central flower field. Each `FlowerPatch` is one of three types
 * (vowel / common / rare) and shows up as a 6-petal arrangement around its
 * (unused) center hex. Petals fall off as they wither — by the time a petal's
 * `witherAt` is close to engine-time it visibly fades and shrinks.
 *
 * To collect a letter the player presses-and-holds a petal. After
 * {@link HOLD_DURATION_MS} a worker bee is dispatched directly — there is no
 * letter queue. The held petal grows a yellow border that finishes drawing
 * around the hex exactly as the timer completes; that border *persists* for
 * the bee's whole flight to mark the petal as claimed (yellow for the player,
 * pink for the rival on contested petals). Trying to hold a petal without
 * enough honey, or with no empty storage to land a letter in, plays a brief
 * red flash instead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  axialToPixel,
  BEE_STATS,
  FIELD_RADIUS,
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
import {
  centeredViewBoxExtent,
  registerGrid,
  unregisterGrid,
} from '../../game/layout.js';
import { HOLD_HINT_SECONDS, useHoldToDispatch } from '../useHoldToDispatch.js';

const HEX_SIZE = 26;
const PETAL_HEX_SIZE = HEX_SIZE * 0.92;

/** Hex path starting at the upper-right vertex (used for tile fills). */
const hexPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

/** Hex path starting at the *top* vertex and going clockwise — used for the
 *  hold border so the line draws downward from 12 o'clock. */
const holdBorderPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

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
  const honey = useGameStore((s) => s.world.self.honey);
  const tiles = useGameStore((s) => s.world.self.tiles);
  const selfBees = useGameStore((s) => s.world.self.bees);
  const oppBees = useGameStore((s) => s.world.opponent.bees);
  const dispatchWorker = useGameStore((s) => s.dispatchWorker);
  const pushToast = useGameStore((s) => s.pushToast);
  const workerCost = BEE_STATS.worker.honeyCost;

  // Pre-flight gating: refuse the hold (and flash red) when there's no
  // chance the resulting dispatch could succeed — i.e. not enough honey,
  // or every storage slot already holds a letter. On rejection we also push
  // a contextual toast at the petal so the player sees *why* the gesture
  // bounced.
  const hasEmptyStorage = useMemo(
    () => tiles.some((t) => t.state === 'storage' && !t.letter),
    [tiles],
  );
  // Refs let canStart see the *latest* values at click time without making
  // the predicate re-create on every honey/tile tick.
  const honeyRef = useRef(honey);
  honeyRef.current = honey;
  const hasEmptyStorageRef = useRef(hasEmptyStorage);
  hasEmptyStorageRef.current = hasEmptyStorage;
  const canStart = useCallback(
    (h: Hex) => {
      if (honeyRef.current < workerCost) {
        pushToast({ text: 'not enough honey', panel: 'flowers', hex: h, variant: 'error' });
        return false;
      }
      if (!hasEmptyStorageRef.current) {
        pushToast({ text: 'storage full', panel: 'flowers', hex: h, variant: 'error' });
        return false;
      }
      return true;
    },
    [workerCost, pushToast],
  );

  const { hold, rejection, start, cancel } = useHoldToDispatch(dispatchWorker, {
    canStart,
  });

  // Petals being targeted by an in-flight worker. While the bee is en route,
  // we keep an outline on the petal so the player can see it's claimed; the
  // rival's claims show up in pink so contested petals are obvious.
  const selfClaims = useMemo(() => {
    const set = new Set<string>();
    for (const bee of selfBees) {
      if (bee.state.kind === 'worker-flying-to-flower') {
        set.add(hexKey(bee.state.target));
      }
    }
    return set;
  }, [selfBees]);
  const oppClaims = useMemo(() => {
    const set = new Set<string>();
    for (const bee of oppBees) {
      if (bee.state.kind === 'worker-flying-to-flower') {
        set.add(hexKey(bee.state.target));
      }
    }
    return set;
  }, [oppBees]);

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

  const holdSeconds = HOLD_HINT_SECONDS;
  const petalBorderD = useMemo(() => holdBorderPath(PETAL_HEX_SIZE), []);
  const petalFlashD = useMemo(() => hexPath(PETAL_HEX_SIZE), []);

  return (
    <div className="grid-frame grid-frame--flowers">
      <h2 className="hud-title grid-heading">FLOWER FIELD</h2>
      <p className="grid-subtitle">
        hold a petal {holdSeconds}s to send a worker · {workerCost}🜨
      </p>
      <div className="flower-field-canvas">
        <svg
          ref={svgRef}
          className="hex-svg hex-svg--flowers"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="flower field"
          style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
          onContextMenu={(e) => e.preventDefault()}
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
                  const scale = 1 - w * 0.35;
                  const petalKey = hexKey(petal.hex);
                  const k = `${patch.id}-${petalKey}`;
                  const isHeld = hold.hex !== null && hexEquals(hold.hex, petal.hex);
                  const isRejected =
                    rejection !== null && hexEquals(rejection.hex, petal.hex);
                  const claimedBySelf = selfClaims.has(petalKey);
                  const claimedByOpp = oppClaims.has(petalKey);
                  const progress = isHeld ? hold.progress : 0;
                  return (
                    <g
                      key={k}
                      transform={`translate(${pp.x},${pp.y}) scale(${scale.toFixed(3)})`}
                      className="flower-petal"
                      data-type={patch.type}
                      data-withering={w > 0.001}
                      data-holding={isHeld}
                      style={{ opacity: 1 - w * 0.55, cursor: 'pointer' }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        // Release implicit capture so the hold cancels cleanly
                        // when the finger drifts off the petal on touch devices.
                        try {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        } catch {
                          // No active capture — ignore.
                        }
                        start(petal.hex);
                      }}
                      onPointerUp={() => cancel(petal.hex)}
                      onPointerLeave={() => cancel(petal.hex)}
                      onPointerCancel={() => cancel(petal.hex)}
                    >
                      <path
                        d={hexPath(PETAL_HEX_SIZE)}
                        className="petal-tile"
                        data-type={patch.type}
                      />
                      <text className="hex-letter petal-letter" x={0} y={0}>
                        {petal.letter}
                      </text>
                      {claimedBySelf && !isHeld && (
                        <path
                          d={petalFlashD}
                          className="claim-border"
                          data-owner="self"
                        />
                      )}
                      {claimedByOpp && (
                        <path
                          d={petalFlashD}
                          className="claim-border"
                          data-owner="opp"
                        />
                      )}
                      {isHeld && (
                        <path
                          d={petalBorderD}
                          className="hold-border"
                          pathLength={100}
                          strokeDasharray={`${(progress * 100).toFixed(2)} 100`}
                        />
                      )}
                      {isRejected && (
                        <path
                          key={rejection.token}
                          d={petalFlashD}
                          className="hex-reject-flash"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
