import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { useGameStore, type PanelIndex } from '../../state/gameStore.js';
import { QueenSpawnButton } from './QueenSpawnButton.js';
import { PanelNav } from './PanelNav.js';
import { applyPanelDirection, type PanelNavContext } from './panelNavigation.js';

interface Props {
  children: readonly ReactNode[];
}

const SWIPE_THRESHOLD_PX = 60;
const SWIPE_DIRECTIONAL_RATIO = 1.2;

/** Panel positions in a 3×3 cross (percent of track). */
const PANEL_OFFSET: Record<PanelIndex, { x: number; y: number }> = {
  0: { x: 0, y: 33.33 },
  1: { x: 33.33, y: 33.33 },
  2: { x: 66.66, y: 33.33 },
  3: { x: 33.33, y: 0 },
  4: { x: 33.33, y: 66.66 },
};

interface SwipeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
}

const panelLabel = (index: PanelIndex, rivalCount: number): string => {
  if (index === 0) return 'YOUR HIVE';
  if (index === 1) return 'FLOWERS';
  if (index === 2) return rivalCount > 1 ? 'RIVAL (right)' : 'RIVAL HIVE';
  if (index === 3) return 'RIVAL (above)';
  return 'RIVAL (below)';
};

export const PanelDeck = ({ children }: Props) => {
  const panel = useGameStore((s) => s.panel);
  const setPanel = useGameStore((s) => s.setPanel);
  const rivalCount = useGameStore((s) => s.world.opponents.length);
  const navCtx: PanelNavContext = useMemo(() => ({ rivalCount }), [rivalCount]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<SwipeState | null>(null);
  const trackAnimated = useRef(false);

  const tabs = useMemo(() => {
    const list: PanelIndex[] = [0, 1, 2];
    if (rivalCount >= 2) list.push(3);
    if (rivalCount >= 3) list.push(4);
    return list;
  }, [rivalCount]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const { x, y } = PANEL_OFFSET[panel];
    if (!trackAnimated.current) {
      trackAnimated.current = true;
      gsap.set(track, { xPercent: -x, yPercent: -y });
      return;
    }
    gsap.to(track, {
      xPercent: -x,
      yPercent: -y,
      duration: 0.45,
      ease: 'power3.out',
    });
  }, [panel]);

  const navigate = useCallback(
    (next: PanelIndex) => {
      if (next === 3 && rivalCount < 2) return;
      if (next === 4 && rivalCount < 3) return;
      if (next === 2 && rivalCount < 1) return;
      setPanel(next);
    },
    [rivalCount, setPanel],
  );

  const goDirection = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      const next = applyPanelDirection(panel, dir, navCtx);
      if (next !== null) navigate(next);
    },
    [panel, navCtx, navigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') navigate(0);
      else if (e.key === '2') navigate(1);
      else if (e.key === '3') navigate(2);
      else if (e.key === '4' && rivalCount >= 2) navigate(3);
      else if (e.key === '5' && rivalCount >= 3) navigate(4);
      else if (e.key === 'ArrowLeft') goDirection('left');
      else if (e.key === 'ArrowRight') goDirection('right');
      else if (e.key === 'ArrowUp') goDirection('up');
      else if (e.key === 'ArrowDown') goDirection('down');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goDirection, rivalCount, setPanel]);

  const tryCommitSwipe = (s: SwipeState): boolean => {
    const dx = s.lastX - s.startX;
    const dy = s.lastY - s.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < SWIPE_THRESHOLD_PX && absY < SWIPE_THRESHOLD_PX) return false;
    if (absX >= absY * SWIPE_DIRECTIONAL_RATIO) {
      goDirection(dx < 0 ? 'right' : 'left');
      return true;
    }
    if (absY >= absX * SWIPE_DIRECTIONAL_RATIO) {
      goDirection(dy < 0 ? 'up' : 'down');
      return true;
    }
    return false;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest('.hex-svg')) {
      swipeRef.current = null;
      return;
    }
    swipeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
  };

  const finishSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    swipeRef.current = null;
    tryCommitSwipe(s);
  };

  const cancelSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    swipeRef.current = null;
    tryCommitSwipe(s);
  };

  return (
    <>
      <div className="panel-tabs" role="tablist">
        {tabs.map((i) => (
          <button
            key={i}
            role="tab"
            type="button"
            aria-selected={panel === i}
            data-active={panel === i}
            className="panel-tab"
            onClick={() => navigate(i)}
          >
            {panelLabel(i, rivalCount)}
          </button>
        ))}
      </div>
      <PanelNav />
      <QueenSpawnButton />
      <div
        className="panel-deck panel-deck-cross"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
      >
        <div ref={trackRef} className="panel-deck-track">
          {children.map((child, i) => (
            <div className="panel" key={i} role="tabpanel" data-panel-index={i}>
              {child}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
