/**
 * Global bee renderer. A fixed-position SVG covering the viewport, on top of
 * the panel deck. For each in-flight bee we look up the from/to waypoints in
 * the layout registry, lerp by progress, and draw a glowing dot.
 *
 * Drone caps interpolate along their path within their owner's hive panel.
 * Workers interpolate between (panel, hex) endpoints and naturally cross
 * panels because they reference different grids.
 */

import { useEffect, useRef, useState } from 'react';
import {
  QUEEN_ACTION_INTERVAL_SECONDS,
  beeFlight,
  hexEquals,
  type Bee,
  type Hex,
} from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { subscribeRegistry, waypointViewport } from '../../game/layout.js';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const colorFor = (kind: string): string =>
  kind === 'worker'
    ? 'var(--honey)'
    : kind === 'drone'
      ? 'var(--neon-pink)'
      : kind === 'queen'
        ? '#fff2c4'
      : 'var(--neon-cyan)';

type QueenHop = { readonly from: Hex; readonly to: Hex; readonly startMs: number };

const beeViewportPos = (
  bee: Bee,
  t: number,
  queenAssaultHopById: Map<string, QueenHop>,
  wallMs: number,
): { x: number; y: number } | null => {
  const flight = beeFlight(bee.state);
  if (flight) {
    const total = flight.arrivesAt - flight.startedAt;
    const progress = total <= 0 ? 1 : Math.min(1, Math.max(0, (t - flight.startedAt) / total));
    const a = waypointViewport(flight.from.panel, flight.from.hex);
    const b = waypointViewport(flight.to.panel, flight.to.hex);
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
      return first ? waypointViewport(bee.state.panel, first) : null;
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
    if (path.length === 1) return waypointViewport(bee.state.panel, path[0]!);
    const local = Math.min(g, segCounts[pi]!);
    const i = Math.min(path.length - 2, Math.floor(local));
    const segT = local - i;
    const a = waypointViewport(bee.state.panel, path[i]!);
    const b = waypointViewport(bee.state.panel, path[i + 1]!);
    if (!a || !b) return null;
    return { x: lerp(a.x, b.x, segT), y: lerp(a.y, b.y, segT) };
  }
  if (bee.state.kind === 'queen-assault') {
    const panel = bee.state.panel;
    const cur = bee.state.currentHex;
    let hop = queenAssaultHopById.get(bee.id);
    if (!hop || !hexEquals(hop.to, cur)) {
      const from = hop?.to ?? cur;
      hop = { from, to: cur, startMs: wallMs };
      queenAssaultHopById.set(bee.id, hop);
    }
    const a = waypointViewport(panel, hop.from);
    const b = waypointViewport(panel, hop.to);
    if (!a || !b) return null;
    if (a.x === b.x && a.y === b.y) return a;
    const u = Math.min(
      1,
      Math.max(0, (wallMs - hop.startMs) / (QUEEN_ACTION_INTERVAL_SECONDS * 1000)),
    );
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
  }
  return null;
};

/** Letters held in flight render alongside the bee for readability. */
const carryingLetter = (bee: Bee): string | null => {
  if (bee.state.kind === 'worker-flying-to-drop') return bee.state.carrying;
  return null;
};

export const BeeOverlay = () => {
  const t = useGameStore((s) => s.world.t);
  const selfBees = useGameStore((s) => s.world.self.bees);
  const oppBees = useGameStore((s) => s.world.opponent.bees);
  const [, force] = useState(0);
  const rafRef = useRef(0);
  const queenAssaultHopRef = useRef(new Map<string, QueenHop>());

  // Re-measure on window resize and panel-deck transitions; cheaper than running
  // every animation frame, and the engine tick already triggers re-renders too.
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => subscribeRegistry(() => force((n) => (n + 1) % 1024)), []);

  // Smooth re-render between engine ticks so bees don't appear to step.
  useEffect(() => {
    const tick = () => {
      force((n) => (n + 1) % 1024);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const bees: Bee[] = [...selfBees, ...oppBees];
  const wallMs = performance.now();
  const hopMap = queenAssaultHopRef.current;
  for (const id of [...hopMap.keys()]) {
    if (!bees.some((b) => b.id === id && b.state.kind === 'queen-assault')) {
      hopMap.delete(id);
    }
  }

  return (
    <svg className="bee-overlay" aria-hidden>
      {bees.map((bee) => {
        const pos = beeViewportPos(bee, t, queenAssaultHopRef.current, wallMs);
        if (!pos) return null;
        const letter = carryingLetter(bee);
        return (
          <g
            key={bee.id}
            transform={`translate(${pos.x},${pos.y})`}
            className="bee"
            data-kind={bee.kind}
            style={{ color: colorFor(bee.kind) }}
          >
            <circle r={6} fill="currentColor" />
            <circle r={11} fill="none" stroke="currentColor" opacity={0.4} />
            {bee.kind === 'queen' && (
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
      })}
    </svg>
  );
};
