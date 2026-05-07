/**
 * Hex-anchored popup messages.
 *
 * Each toast is positioned via the cross-panel layout registry: it tracks the
 * tile the player just touched (e.g. the petal they tried to hold without
 * enough honey) and rises out of that tile while fading. The overlay is
 * `position: fixed` and `pointer-events: none`, so toasts never block input.
 *
 * Lifetimes are short (`TOAST_LIFETIME_MS`); the renderer re-runs each frame
 * while at least one toast is alive so the rise + fade stays smooth even if
 * the panel deck is sliding underneath the toast at the same time.
 */

import { useEffect, useState } from 'react';
import {
  TOAST_LIFETIME_MS,
  useGameStore,
  type Toast,
} from '../../state/gameStore.js';
import {
  subscribeRegistry,
  waypointViewport,
} from '../../game/layout.js';

/** How far the toast drifts upward over its lifetime, in viewport pixels. */
const RISE_PX = 38;
/** Fraction of lifetime spent fully opaque before the fade-out begins. */
const HOLD_FRACTION = 0.55;

interface RenderedToast {
  readonly toast: Toast;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

const computeFrame = (toast: Toast, now: number): RenderedToast | null => {
  const age = now - toast.createdAt;
  if (age < 0 || age >= TOAST_LIFETIME_MS) return null;
  const pos = waypointViewport(toast.panel, toast.hex);
  if (!pos) return null;
  const t = age / TOAST_LIFETIME_MS;
  const opacity = t < HOLD_FRACTION ? 1 : 1 - (t - HOLD_FRACTION) / (1 - HOLD_FRACTION);
  return {
    toast,
    x: pos.x,
    y: pos.y - RISE_PX * t,
    opacity,
  };
};

export const Toasts = () => {
  const toasts = useGameStore((s) => s.toasts);

  // Re-render every animation frame while we have something to show. This is
  // the cheapest way to keep `getBoundingClientRect`-derived positions in
  // sync with panel-deck slide animations, the wither rAF in FlowerField, etc.
  const [, force] = useState(0);
  useEffect(() => {
    if (toasts.length === 0) return;
    let rafId = 0;
    const tick = () => {
      force((n) => (n + 1) % 1024);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [toasts.length]);

  // Re-render when grids register/unregister so positions snap into place
  // the moment a panel mounts.
  useEffect(() => subscribeRegistry(() => force((n) => (n + 1) % 1024)), []);

  if (toasts.length === 0) return null;

  const now = performance.now();
  const frames = toasts
    .map((t) => computeFrame(t, now))
    .filter((f): f is RenderedToast => f !== null);

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {frames.map(({ toast, x, y, opacity }) => (
        <div
          key={toast.id}
          className="toast"
          data-variant={toast.variant}
          style={{
            left: `${x}px`,
            top: `${y}px`,
            opacity,
          }}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
};
