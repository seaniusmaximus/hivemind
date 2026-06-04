/**
 * Global bee renderer. A fixed-position SVG covering the viewport, on top of
 * the panel deck. For each in-flight bee we look up the from/to waypoints in
 * the layout registry, lerp by progress, and draw a glowing dot.
 *
 * Drone caps interpolate along their path within their owner's hive panel.
 * Workers interpolate between (panel, hex) endpoints and naturally cross
 * panels because they reference different grids.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  QUEEN_ACTION_INTERVAL_SECONDS,
  beeFlight,
  distance,
  hex,
  hexEquals,
  hexKey,
  neighbors,
  type Bee,
  type Hex,
} from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { beeWaypointViewport, subscribeRegistry } from '../../game/layout.js';
import { BeeSprite } from './BeeSprite.js';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Wind-up share of the queen assault interval (rear-back before stab). */
const QUEEN_ASSAULT_WIND_PHASE = 0.34;
/** How far the wind-up pulls toward `from` from the target hex (along the chord). */
const QUEEN_REAR_PULL = 0.22;

/** Peak strike flash during the stab phase (0..1). */
const strikeSparkOpacity = (stabU: number): number => {
  if (stabU < 0.52) return 0;
  if (stabU < 0.78) return (stabU - 0.52) / 0.26;
  return Math.max(0, 1 - (stabU - 0.78) / 0.22);
};

const colorFor = (kind: string): string =>
  kind === 'worker'
    ? 'var(--honey)'
    : kind === 'drone'
      ? 'var(--neon-pink)'
      : kind === 'queen'
        ? '#fff2c4'
      : 'var(--neon-cyan)';

type QueenHop = {
  readonly from: Hex;
  readonly to: Hex;
  /** Engine time when this hop's strike animation started. */
  readonly hopStartT: number;
  /** Engine `nextActionAt` when this hop was keyed — advances each strike even if `currentHex` is unchanged. */
  readonly boundNextActionAt: number;
  /** First assault after flight: wind-up starts on the target hex (matches landing), not the synthetic `from` hex. */
  readonly landingLeadIn?: true;
};

const HIVE_HEX = hex(0, 0);

/** Neighbor of `cur` farthest from the hive — reads as “approach from the rim” for the first strike. */
const outwardStrikeFromHex = (cur: Hex): Hex => {
  const nbrs = neighbors(cur);
  let best = nbrs[0]!;
  let bestD = distance(best, HIVE_HEX);
  for (const n of nbrs) {
    const d = distance(n, HIVE_HEX);
    if (d > bestD || (d === bestD && hexKey(n) < hexKey(best))) {
      best = n;
      bestD = d;
    }
  }
  return best;
};

type BeeViewportVisual = {
  readonly x: number;
  readonly y: number;
  readonly rotationDeg?: number;
  readonly strikeSpark?: { readonly cx: number; readonly cy: number; readonly opacity: number };
};

const beeViewportVisual = (
  bee: Bee,
  t: number,
  queenAssaultHopById: Map<string, QueenHop>,
): BeeViewportVisual | null => {
  const flight = beeFlight(bee.state);
  if (flight) {
    const total = flight.arrivesAt - flight.startedAt;
    const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, (t - flight.startedAt) / total));
    const a = beeWaypointViewport(flight.from.panel, flight.from.hex);
    const b = beeWaypointViewport(flight.to.panel, flight.to.hex);
    if (!a || !b) return null;
    return { x: lerp(a.x, b.x, progress), y: lerp(a.y, b.y, progress) };
  }
  if (bee.state.kind === 'capping') {
    // Drone walks one or more word paths in sequence. Each path's animation
    // share is proportional to its segment count.
    const paths = bee.state.paths;
    const total = bee.state.arrivesAt - bee.state.startedAt;
    if (total <= 0 || paths.length === 0) {
      const first = paths[0]?.[0];
      return first ? beeWaypointViewport(bee.state.panel, first) : null;
    }
    const progress = Math.min(1, Math.max(0, (t - bee.state.startedAt) / total));
    const segCounts = paths.map((p) => Math.max(1, p.length - 1));
    const totalSegs = segCounts.reduce((s, n) => s + n, 0);
    let g = progress * totalSegs;
    let pi = 0;
    while (pi < paths.length - 1 && g > segCounts[pi]!) {
      g -= segCounts[pi]!;
      pi += 1;
    }
    const path = paths[pi]!;
    if (path.length === 1) return beeWaypointViewport(bee.state.panel, path[0]!);
    const local = Math.min(g, segCounts[pi]!);
    const i = Math.min(path.length - 2, Math.floor(local));
    const segT = local - i;
    const a = beeWaypointViewport(bee.state.panel, path[i]!);
    const b = beeWaypointViewport(bee.state.panel, path[i + 1]!);
    if (!a || !b) return null;
    return { x: lerp(a.x, b.x, segT), y: lerp(a.y, b.y, segT) };
  }
  if (bee.state.kind === 'queen-assault') {
    const panel = bee.state.panel;
    const cur = bee.state.currentHex;
    const nextAt = bee.state.nextActionAt;
    const prevHop = queenAssaultHopById.get(bee.id);
    let hop: QueenHop;
    const prevBound = prevHop?.boundNextActionAt;
    const nextActionAdvanced =
      prevHop != null && prevBound !== undefined && prevBound !== nextAt;

    if (!prevHop || !hexEquals(prevHop.to, cur)) {
      // First assault hex (no prior hop): `from` is a synthetic neighbor so aim/stab still make sense
      // (see outwardStrikeFromHex). `landingLeadIn` makes wind start at `b` so we don't jump from the flight end.
      const hadPriorHop = prevHop != null;
      const from = hadPriorHop ? prevHop.to : outwardStrikeFromHex(cur);
      hop = {
        from,
        to: cur,
        hopStartT: t,
        boundNextActionAt: nextAt,
        ...(hadPriorHop ? {} : { landingLeadIn: true as const }),
      };
      queenAssaultHopById.set(bee.id, hop);
    } else if (nextActionAdvanced) {
      // Same hex, new strike: `from === to` would skip the pose — use synthetic rim + lead-in from center.
      hop = {
        from: outwardStrikeFromHex(cur),
        to: cur,
        hopStartT: t,
        boundNextActionAt: nextAt,
        landingLeadIn: true,
      };
      queenAssaultHopById.set(bee.id, hop);
    } else {
      hop = prevHop;
    }
    const a = beeWaypointViewport(panel, hop.from);
    const b = beeWaypointViewport(panel, hop.to);
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const u = Math.min(
      1,
      Math.max(0, (t - hop.hopStartT) / QUEEN_ACTION_INTERVAL_SECONDS),
    );

    if (dist < 0.75) {
      return { x: b.x, y: b.y, rotationDeg: 0 };
    }

    // Pull-back pose sits between target and approach direction (near `b`). Wind phase
    // moves from the previous hex center `a` → `rearPoint` so each new hop starts at `a`
    // (where the last stab ended) instead of a point near `b` — that was causing a visible jump.
    const rearPoint = {
      x: b.x + (a.x - b.x) * QUEEN_REAR_PULL,
      y: b.y + (a.y - b.y) * QUEEN_REAR_PULL,
    };
    const aimDeg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;

    if (u < QUEEN_ASSAULT_WIND_PHASE) {
      const w = smoothstep(u / QUEEN_ASSAULT_WIND_PHASE);
      const windFrom = hop.landingLeadIn === true ? b : a;
      const px = lerp(windFrom.x, rearPoint.x, w);
      const py = lerp(windFrom.y, rearPoint.y, w);
      const tilt = lerp(0, -22, w);
      return { x: px, y: py, rotationDeg: aimDeg + tilt };
    }

    const stabU = Math.min(1, Math.max(0, (u - QUEEN_ASSAULT_WIND_PHASE) / (1 - QUEEN_ASSAULT_WIND_PHASE)));
    const s = smoothstep(stabU);
    const px = lerp(rearPoint.x, b.x, s);
    const py = lerp(rearPoint.y, b.y, s);
    const tilt = lerp(-22, 14, smoothstep(stabU));
    const sparkOp = strikeSparkOpacity(stabU);
    const base = {
      x: px,
      y: py,
      rotationDeg: aimDeg + tilt,
    } as const;
    return sparkOp > 0.03
      ? {
          ...base,
          strikeSpark: { cx: b.x, cy: b.y, opacity: sparkOp } as const,
        }
      : base;
  }
  return null;
};

const STRIKE_RAY_COUNT = 8;
const STRIKE_RAY_LEN = 13;

const QueenStrikeSpark = ({
  cx,
  cy,
  opacity,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly opacity: number;
}) => (
  <g
    className="queen-strike-spark"
    transform={`translate(${cx},${cy})`}
    style={{ opacity }}
    aria-hidden
  >
    {Array.from({ length: STRIKE_RAY_COUNT }, (_, i) => {
      const ang = ((Math.PI * 2) / STRIKE_RAY_COUNT) * i - Math.PI / 2;
      const x2 = Math.cos(ang) * STRIKE_RAY_LEN;
      const y2 = Math.sin(ang) * STRIKE_RAY_LEN;
      return (
        <line
          key={i}
          className="queen-strike-ray"
          x1={0}
          y1={0}
          x2={x2}
          y2={y2}
        />
      );
    })}
    <circle className="queen-strike-core" r={3.2} cx={0} cy={0} />
  </g>
);

/** Letters held in flight render alongside the bee for readability. */
const carryingLetter = (bee: Bee): string | null => {
  if (bee.state.kind === 'worker-flying-to-door-carrying') return bee.state.carrying ?? null;
  return null;
};

/** Max gap before snapping display time to authoritative engine time (online snapshots). */
const DISPLAY_T_SNAP_SEC = 0.28;

export const BeeOverlay = () => {
  const engineT = useGameStore((s) => s.world.t);
  const selfBees = useGameStore((s) => s.world.self.bees);
  const opponents = useGameStore((s) => s.world.opponents);
  const oppBees = useMemo(() => opponents.flatMap((o) => o.bees), [opponents]);
  const [, force] = useState(0);
  const rafRef = useRef(0);
  const queenAssaultHopRef = useRef(new Map<string, QueenHop>());
  const displayTRef = useRef(engineT);

  useEffect(() => {
    if (engineT > displayTRef.current + DISPLAY_T_SNAP_SEC) {
      displayTRef.current = engineT;
    } else if (engineT < displayTRef.current) {
      displayTRef.current = engineT;
    }
  }, [engineT]);

  const t = displayTRef.current;

  // Re-measure on window resize and panel-deck transitions; cheaper than running
  // every animation frame, and the engine tick already triggers re-renders too.
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => subscribeRegistry(() => force((n) => (n + 1) % 1024)), []);

  // Smooth re-render between engine ticks; advance display time toward engine time.
  useEffect(() => {
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = useGameStore.getState().world.t;
      let next = displayTRef.current + dt;
      if (target > next + DISPLAY_T_SNAP_SEC) next = target;
      if (target < next) next = target;
      displayTRef.current = Math.min(target, next);
      force((n) => (n + 1) % 1024);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const bees: Bee[] = [...selfBees, ...oppBees];
  const hopMap = queenAssaultHopRef.current;
  for (const id of [...hopMap.keys()]) {
    if (!bees.some((b) => b.id === id && b.state.kind === 'queen-assault')) {
      hopMap.delete(id);
    }
  }

  const visuals = bees
    .map((bee) => {
      const vis = beeViewportVisual(bee, t, queenAssaultHopRef.current);
      return vis ? { bee, vis } : null;
    })
    .filter((v): v is { bee: Bee; vis: BeeViewportVisual } => v !== null);

  return (
    <svg className="bee-overlay" aria-hidden>
      {visuals.map(({ bee, vis }) =>
        vis.strikeSpark ? (
          <QueenStrikeSpark
            key={`${bee.id}-strike`}
            cx={vis.strikeSpark.cx}
            cy={vis.strikeSpark.cy}
            opacity={vis.strikeSpark.opacity}
          />
        ) : null,
      )}
      {visuals.map(({ bee, vis }) => (
        <BeeSprite
          key={bee.id}
          color={colorFor(bee.kind)}
          kind={bee.kind}
          letter={carryingLetter(bee)}
          x={vis.x}
          y={vis.y}
          {...(vis.rotationDeg !== undefined ? { rotationDeg: vis.rotationDeg } : {})}
        />
      ))}
    </svg>
  );
};
