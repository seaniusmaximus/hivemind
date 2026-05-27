import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { useGameStore, type PanelIndex } from '../../state/gameStore.js';
import { QueenSpawnButton } from './QueenSpawnButton.js';

interface Props {
  children: readonly ReactNode[];
}

const PANEL_LABELS = ['YOUR HIVE', 'FLOWERS', 'RIVAL HIVE'] as const;

/** Min horizontal travel (in px) before a pointer drag is treated as a panel
 *  swipe. Tuned so a deliberate flick reliably navigates without stealing
 *  short taps on toolbar buttons. */
const SWIPE_THRESHOLD_PX = 60;
/** Required ratio of horizontal-to-vertical motion. Above this ratio the
 *  gesture is a swipe; below it we assume the user is scrolling or holding. */
const SWIPE_DIRECTIONAL_RATIO = 1.2;

interface SwipeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Last observed pointer x. Tracked on every move so we can still commit a
   *  swipe from `pointercancel` (iOS sometimes cancels pointer events when a
   *  system gesture takes over the touch mid-flick). */
  lastX: number;
  lastY: number;
}

export const PanelDeck = ({ children }: Props) => {
  const panel = useGameStore((s) => s.panel);
  const setPanel = useGameStore((s) => s.setPanel);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<SwipeState | null>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    gsap.to(track, {
      xPercent: -100 * panel,
      duration: 0.45,
      ease: 'power3.out',
    });
  }, [panel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') setPanel(0);
      else if (e.key === '2') setPanel(1);
      else if (e.key === '3') setPanel(2);
      else if (e.key === 'ArrowLeft') setPanel(Math.max(0, panel - 1) as PanelIndex);
      else if (e.key === 'ArrowRight') setPanel(Math.min(2, panel + 1) as PanelIndex);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, setPanel]);

  // Pointer-based swipe navigation. We skip any gesture that starts inside
  // the hex SVG — those drags belong to word drafting / letter placement and
  // a horizontal sweep across hexes must not also flip the panel.
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

  const tryCommitSwipe = (s: SwipeState): boolean => {
    const dx = s.lastX - s.startX;
    const dy = s.lastY - s.startY;
    if (
      Math.abs(dx) < SWIPE_THRESHOLD_PX ||
      Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTIONAL_RATIO
    ) {
      return false;
    }
    const next = dx < 0 ? Math.min(2, panel + 1) : Math.max(0, panel - 1);
    if (next !== panel) setPanel(next as PanelIndex);
    return true;
  };

  const finishSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    swipeRef.current = null;
    tryCommitSwipe(s);
  };

  // iOS can fire `pointercancel` when a system gesture (back-swipe from the
  // edge, gesture nav) claims the touch. If the user already crossed the
  // swipe threshold by then, honor it — otherwise just drop the state.
  const cancelSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    swipeRef.current = null;
    tryCommitSwipe(s);
  };

  return (
    <>
      <div className="panel-tabs" role="tablist">
        {PANEL_LABELS.map((label, i) => (
          <button
            key={label}
            role="tab"
            type="button"
            aria-selected={panel === i}
            data-active={panel === i}
            className="panel-tab"
            onClick={() => setPanel(i as PanelIndex)}
          >
            {label}
          </button>
        ))}
      </div>
      <QueenSpawnButton />
      <div
        className="panel-deck"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
      >
        <button
          type="button"
          className="panel-arrow panel-arrow-left"
          data-tutorial-target="panel-arrow-left"
          aria-label={
            panel > 0 ? `go to ${PANEL_LABELS[panel - 1]}` : 'no previous panel'
          }
          onClick={() => setPanel(Math.max(0, panel - 1) as PanelIndex)}
          disabled={panel === 0}
        >
          <svg viewBox="0 0 12 24" aria-hidden focusable="false">
            <polyline
              points="9,3 3,12 9,21"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div
          ref={trackRef}
          style={{ display: 'flex', width: '300%', height: '100%' }}
        >
          {children.map((child, i) => (
            <div className="panel" key={i} role="tabpanel" data-panel-index={i}>
              {child}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="panel-arrow panel-arrow-right"
          data-tutorial-target="panel-arrow-right"
          aria-label={
            panel < 2 ? `go to ${PANEL_LABELS[panel + 1]}` : 'no next panel'
          }
          onClick={() => setPanel(Math.min(2, panel + 1) as PanelIndex)}
          disabled={panel === 2}
        >
          <svg viewBox="0 0 12 24" aria-hidden focusable="false">
            <polyline
              points="3,3 9,12 3,21"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </>
  );
};
