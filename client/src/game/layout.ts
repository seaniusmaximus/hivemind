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

import { axialToPixel, hexEquals, hex, type BeePanel, type Hex } from '@hivemind/shared';

const HIVE_HEX = hex(0, 0);

/** Hive tile is drawn slightly larger than registry `hexSize` (see HiveGrid). */
export const HIVE_HEX_DRAW_SCALE = 1.05;
/** Small door hex circumradius as a fraction of the drawn hive hex radius. */
export const HIVE_DOOR_HEX_FR = 0.18;
/** Nudge door center toward the hive core (fraction of drawn hive radius, subtracted from center Y). */
export const HIVE_DOOR_UPSHIFT_FR = 0.2;

/** Local Y offset (same units as {@link axialToPixel}) from hive center to the small door hex center. */
const HIVE_DOOR_OFFSET_Y = (hexSize: number) =>
  hexSize *
  HIVE_HEX_DRAW_SCALE *
  (1 - HIVE_DOOR_HEX_FR - HIVE_DOOR_UPSHIFT_FR);

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
const toViewport = (
  reg: GridRegistration,
  rect: DOMRect,
  local: { readonly x: number; readonly y: number },
): { x: number; y: number } => {
  const scaleX = rect.width / (reg.viewBoxHalfWidth * 2);
  const scaleY = rect.height / (reg.viewBoxHalfHeight * 2);
  return {
    x: rect.left + rect.width / 2 + local.x * scaleX,
    y: rect.top + rect.height / 2 + local.y * scaleY,
  };
};

export const waypointViewport = (
  panel: BeePanel,
  h: Hex,
): { x: number; y: number } | null => {
  const reg = registry[panel];
  if (!reg || !reg.el) return null;
  const rect = reg.el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const local = axialToPixel(h, reg.hexSize);
  return toViewport(reg, rect, local);
};

/**
 * Waypoint for rendering bees: same as {@link waypointViewport}, but exits at
 * the hive door (hex 0,0 on hive panels) instead of the hex geometric center.
 */
export const beeWaypointViewport = (
  panel: BeePanel,
  h: Hex,
): { x: number; y: number } | null => {
  const reg = registry[panel];
  if (!reg || !reg.el) return null;
  const rect = reg.el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  let local = axialToPixel(h, reg.hexSize);
  if (
    (panel === 'self-hive' || panel === 'opponent-hive') &&
    hexEquals(h, HIVE_HEX)
  ) {
    local = { x: local.x, y: local.y + HIVE_DOOR_OFFSET_Y(reg.hexSize) };
  }
  return toViewport(reg, rect, local);
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
