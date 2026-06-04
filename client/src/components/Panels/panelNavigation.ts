import type { PanelIndex } from '../../state/gameStore.js';

export interface PanelNavContext {
  readonly rivalCount: number;
}

/** Next panel when pressing left, or null if already at the leftmost target. */
export const panelGoLeft = (panel: PanelIndex, _ctx: PanelNavContext): PanelIndex | null => {
  switch (panel) {
    case 0:
      return null;
    case 1:
      return 0;
    case 2:
      return 1;
    case 3:
    case 4:
      return 0;
    default:
      return null;
  }
};

/** Next panel when pressing right, or null if already at the rightmost target. */
export const panelGoRight = (panel: PanelIndex, ctx: PanelNavContext): PanelIndex | null => {
  if (ctx.rivalCount < 1) {
    return panel === 0 ? 1 : null;
  }
  switch (panel) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return null;
    case 3:
    case 4:
      return 2;
    default:
      return null;
  }
};

/** Next panel when pressing up (top rival from hive row), or null. */
export const panelGoUp = (panel: PanelIndex, ctx: PanelNavContext): PanelIndex | null => {
  if (ctx.rivalCount < 2) return null;
  switch (panel) {
    case 0:
    case 1:
    case 2:
      return 3;
    case 3:
      return null;
    case 4:
      return 1;
    default:
      return null;
  }
};

/** Next panel when pressing down (bottom rival from hive row), or null. */
export const panelGoDown = (panel: PanelIndex, ctx: PanelNavContext): PanelIndex | null => {
  if (ctx.rivalCount < 3) return null;
  switch (panel) {
    case 0:
    case 1:
    case 2:
      return 4;
    case 3:
      return 1;
    case 4:
      return null;
    default:
      return null;
  }
};

export const applyPanelDirection = (
  panel: PanelIndex,
  dir: 'left' | 'right' | 'up' | 'down',
  ctx: PanelNavContext,
): PanelIndex | null => {
  switch (dir) {
    case 'left':
      return panelGoLeft(panel, ctx);
    case 'right':
      return panelGoRight(panel, ctx);
    case 'up':
      return panelGoUp(panel, ctx);
    case 'down':
      return panelGoDown(panel, ctx);
  }
};

/** Whether a panel index is reachable in the current match (for jump buttons). */
export const canNavigateToPanel = (index: PanelIndex, ctx: PanelNavContext): boolean => {
  switch (index) {
    case 0:
    case 1:
      return true;
    case 2:
      return ctx.rivalCount >= 1;
    case 3:
      return ctx.rivalCount >= 2;
    case 4:
      return ctx.rivalCount >= 3;
    default:
      return false;
  }
};
