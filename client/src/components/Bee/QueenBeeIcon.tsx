/**
 * Static queen bee glyph — same hex body, stripe, and wings as {@link BeeSprite}
 * (no crown, no GSAP). Used for queen-slot indicators in the spawn UI.
 */

const BODY_SIZE = 6;
const WING_SIZE = 3.8;
const WING_OFFSET = 4.2;
const WING_VERTICAL = -2.6;

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

type Props = {
  readonly className?: string;
};

export const QueenBeeIcon = ({ className }: Props) => (
  <svg
    className={className}
    viewBox="-12 -12 24 24"
    aria-hidden
    focusable="false"
  >
    <g className="queen-bee-glyph">
      <g transform={`translate(${-WING_OFFSET / 2},0)`}>
        <g transform={`translate(${-WING_OFFSET},${WING_VERTICAL}) rotate(-12)`}>
          <path className="bee-wing-shape" d={WING_PATH} />
        </g>
      </g>
      <g transform={`translate(${WING_OFFSET / 2},0)`}>
        <g transform={`translate(${WING_OFFSET},${WING_VERTICAL}) rotate(12)`}>
          <path className="bee-wing-shape" d={WING_PATH} />
        </g>
      </g>
      <path d={BODY_PATH} className="bee-body" />
      <rect className="bee-stripe" x={-5} y={-1.3} width={10} height={2.6} />
    </g>
  </svg>
);
