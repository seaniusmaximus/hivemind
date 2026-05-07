/**
 * Cross-panel layout registry.
 *
 * Each grid (self-hive, flowers, opponent-hive) registers its own SVG element
 * here. The bee overlay uses these refs + the per-grid viewBox/hex-size info
 * to translate (panel, hex) waypoints into viewport pixel coordinates.
 *
 * The grids use centered, symmetric viewBoxes so that hex (0, 0) lines up with
 * the SVG element's geometric center; that lets us compute pixel offsets by
 * just scaling axialToPixel by `rect.width / viewBoxWidth`.
 */

import { axialToPixel, type BeePanel, type Hex } from '@hivemind/shared';

export interface GridRegistration {
  el: SVGSVGElement | null;
  /** Half-width of the symmetric, origin-centered viewBox. */
  viewBoxHalfWidth: number;
  viewBoxHalfHeight: number;
  hexSize: number;
}

const registry: { [key in BeePanel]?: GridRegistration } = {};

const listeners = new Set<() => void>();

export const registerGrid = (panel: BeePanel, registration: GridRegistration): void => {
  registry[panel] = registration;
  for (const l of listeners) l();
};

export const unregisterGrid = (panel: BeePanel): void => {
  delete registry[panel];
  for (const l of listeners) l();
};

export const getGrid = (panel: BeePanel): GridRegistration | undefined => registry[panel];

export const subscribeRegistry = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Convert a (panel, hex) waypoint to a viewport pixel position. Returns null
 * if the panel hasn't registered yet.
 */
export const waypointViewport = (
  panel: BeePanel,
  h: Hex,
): { x: number; y: number } | null => {
  const reg = registry[panel];
  if (!reg || !reg.el) return null;
  const rect = reg.el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const local = axialToPixel(h, reg.hexSize);
  const scaleX = rect.width / (reg.viewBoxHalfWidth * 2);
  const scaleY = rect.height / (reg.viewBoxHalfHeight * 2);
  return {
    x: rect.left + rect.width / 2 + local.x * scaleX,
    y: rect.top + rect.height / 2 + local.y * scaleY,
  };
};

/**
 * Compute a centered viewBox half-extent that fits the given hex coordinates
 * (with a hex-radius padding). Used by the grid components when sizing their
 * SVGs so the registry math stays simple.
 */
export const centeredViewBoxExtent = (
  hexes: readonly Hex[],
  hexSize: number,
): { halfWidth: number; halfHeight: number } => {
  let maxAbsX = 0;
  let maxAbsY = 0;
  for (const h of hexes) {
    const p = axialToPixel(h, hexSize);
    if (Math.abs(p.x) > maxAbsX) maxAbsX = Math.abs(p.x);
    if (Math.abs(p.y) > maxAbsY) maxAbsY = Math.abs(p.y);
  }
  return {
    halfWidth: maxAbsX + hexSize * 1.6,
    halfHeight: maxAbsY + hexSize * 1.6,
  };
};
