/**
 * Visual for a single in-flight bee. Drawn as a small pointy-top hexagon
 * body with a horizontal stripe through the middle and two smaller hex
 * "wings" off each side that flap continuously via a GSAP rotation tween.
 *
 * The parent `<g>` carries the `translate(x,y)` that React updates every
 * animation frame; the wing refs point at inner `<g>`s whose rotation is
 * driven entirely by GSAP and is therefore preserved across re-renders.
 */

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

type Props = {
  readonly color: string;
  readonly kind: string;
  readonly letter: string | null;
  readonly x: number;
  readonly y: number;
  /** Degrees; rotation about bee center after translate (e.g. queen stab tilt). */
  readonly rotationDeg?: number;
};

const BODY_SIZE = 6;
const WING_SIZE = 3.8;
const WING_OFFSET = 4.2;
const WING_VERTICAL = -2.6;

/** Pointy-top hex path centered at the origin (matches HiveGrid). */
const hexPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const x = size * Math.cos(angle);
    const y = size * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
};

const BODY_PATH = hexPath(BODY_SIZE);
const WING_PATH = hexPath(WING_SIZE);

export const BeeSprite = ({
  color,
  kind,
  letter,
  x,
  y,
  rotationDeg = 0,
}: Props) => {
  const leftWingRef = useRef<SVGGElement | null>(null);
  const rightWingRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const left = leftWingRef.current;
    const right = rightWingRef.current;
    if (!left || !right) return;
    // Stagger each bee's flap phase a touch so a swarm doesn't beat in unison.
    const delay = Math.random() * 0.12;
    gsap.set(left, { rotation: -8, transformOrigin: 'right center' });
    gsap.set(right, { rotation: 8, transformOrigin: 'left center' });
    const tweenL = gsap.to(left, {
      rotation: 22,
      duration: 0.18,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      delay,
    });
    const tweenR = gsap.to(right, {
      rotation: -22,
      duration: 0.18,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      delay,
    });
    return () => {
      tweenL.kill();
      tweenR.kill();
    };
  }, []);

  return (
    <g
      className="bee"
      transform={`translate(${x},${y}) rotate(${rotationDeg})`}
      data-kind={kind}
      style={{ color }}
    >
      <g transform={`translate(${-WING_OFFSET / 2},0)`}>
        <g ref={leftWingRef}>
          <path
            className="bee-wing-shape"
            d={WING_PATH}
            transform={`translate(${-WING_OFFSET},${WING_VERTICAL})`}
          />
        </g>
      </g>
      <g transform={`translate(${WING_OFFSET / 2},0)`}>
        <g ref={rightWingRef}>
          <path
            className="bee-wing-shape"
            d={WING_PATH}
            transform={`translate(${WING_OFFSET},${WING_VERTICAL})`}
          />
        </g>
      </g>
      <path d={BODY_PATH} className="bee-body" />
      <rect className="bee-stripe" x={-5} y={-1.3} width={10} height={2.6} />
      {kind === 'queen' && (
        <text className="bee-letter" x={0} y={-14}>
          👑
        </text>
      )}
      {letter && (
        <text className="bee-letter" x={0} y={-14}>
          {letter}
        </text>
      )}
    </g>
  );
};
