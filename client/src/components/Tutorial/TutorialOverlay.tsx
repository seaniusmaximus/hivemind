import { useEffect, useLayoutEffect, useState } from 'react';
import {
  tutorialStepConfig,
  type TutorialTarget,
} from '../../game/tutorialSteps.js';
import { useGameStore, type PanelIndex } from '../../state/gameStore.js';

const TARGET_SELECTOR = (t: TutorialTarget): string => `[data-tutorial-target="${t}"]`;

/** Matches {@link PanelDeck} panel slide duration. */
const PANEL_SLIDE_MS = 480;
const HIGHLIGHT_PAD_PX = 6;
const VIEWPORT_MARGIN_PX = 4;

interface HighlightRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const isRectOnScreen = (r: DOMRect): boolean =>
  r.width > 2 &&
  r.height > 2 &&
  r.right > VIEWPORT_MARGIN_PX &&
  r.bottom > VIEWPORT_MARGIN_PX &&
  r.left < window.innerWidth - VIEWPORT_MARGIN_PX &&
  r.top < window.innerHeight - VIEWPORT_MARGIN_PX;

const clampHighlight = (rect: HighlightRect): HighlightRect => {
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.left, window.innerWidth - VIEWPORT_MARGIN_PX - 8),
  );
  const top = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.top, window.innerHeight - VIEWPORT_MARGIN_PX - 8),
  );
  const right = Math.min(window.innerWidth - VIEWPORT_MARGIN_PX, rect.left + rect.width);
  const bottom = Math.min(window.innerHeight - VIEWPORT_MARGIN_PX, rect.top + rect.height);
  return {
    left,
    top,
    width: Math.max(8, right - left),
    height: Math.max(8, bottom - top),
  };
};

const panelRoot = (panel: PanelIndex): Element | null =>
  document.querySelector(`.panel-deck .panel[data-panel-index="${panel}"]`);

const measureTarget = (root: ParentNode, target: TutorialTarget): HighlightRect | null => {
  const els = root.querySelectorAll(TARGET_SELECTOR(target));
  if (els.length === 0) return null;

  const visibleRects = [...els]
    .map((el) => el.getBoundingClientRect())
    .filter(isRectOnScreen);
  if (visibleRects.length === 0) return null;

  const left = Math.min(...visibleRects.map((r) => r.left));
  const top = Math.min(...visibleRects.map((r) => r.top));
  const right = Math.max(...visibleRects.map((r) => r.right));
  const bottom = Math.max(...visibleRects.map((r) => r.bottom));

  return clampHighlight({
    left: left - HIGHLIGHT_PAD_PX,
    top: top - HIGHLIGHT_PAD_PX,
    width: right - left + HIGHLIGHT_PAD_PX * 2,
    height: bottom - top + HIGHLIGHT_PAD_PX * 2,
  });
};

const isGlobalTutorialTarget = (target: TutorialTarget): boolean =>
  target === 'queen-spawn' ||
  target === 'panel-arrow-left' ||
  target === 'panel-arrow-right';

const measureHighlights = (
  targets: readonly TutorialTarget[],
  panel: PanelIndex,
): readonly HighlightRect[] => {
  const panelEl = panelRoot(panel);
  const out: HighlightRect[] = [];

  for (const target of targets) {
    if (isGlobalTutorialTarget(target)) {
      const r = measureTarget(document, target);
      if (r) out.push(r);
      continue;
    }
    if (!panelEl) continue;
    const r = measureTarget(panelEl, target);
    if (r) out.push(r);
  }
  return out;
};

export const TutorialOverlay = () => {
  const tutorialActive = useGameStore((s) => s.tutorialActive);
  const tutorialPaused = useGameStore((s) => s.tutorialPaused);
  const tutorialStep = useGameStore((s) => s.tutorialStep);
  const panel = useGameStore((s) => s.panel);
  const advanceTutorial = useGameStore((s) => s.advanceTutorial);

  const config = tutorialStepConfig(tutorialStep);
  const [highlights, setHighlights] = useState<readonly HighlightRect[]>([]);

  useEffect(() => {
    if (!tutorialActive || !tutorialPaused || !config) return;
    useGameStore.getState().setPanel(config.panel);
  }, [tutorialActive, tutorialPaused, config?.id, config?.panel]);

  useLayoutEffect(() => {
    if (!tutorialActive || !tutorialPaused || !config) {
      setHighlights([]);
      return;
    }

    let cancelled = false;
    const update = () => {
      if (!cancelled) {
        setHighlights(measureHighlights(config.targets, config.panel));
      }
    };

    update();
    const afterSlide = window.setTimeout(update, PANEL_SLIDE_MS);
    const raf = requestAnimationFrame(update);

    const unsub = useGameStore.subscribe((s, prev) => {
      if (s.panel !== prev.panel) {
        update();
        window.setTimeout(update, PANEL_SLIDE_MS);
      }
    });
    window.addEventListener('resize', update);

    return () => {
      cancelled = true;
      window.clearTimeout(afterSlide);
      cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener('resize', update);
    };
  }, [tutorialActive, tutorialPaused, config, panel]);

  if (!tutorialActive || !tutorialPaused || !config) return null;

  return (
    <div className="tutorial-overlay" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
      {highlights.map((h, i) => (
        <div
          key={i}
          className="tutorial-highlight"
          style={{
            left: `${h.left}px`,
            top: `${h.top}px`,
            width: `${h.width}px`,
            height: `${h.height}px`,
          }}
          aria-hidden
        />
      ))}
      <div className="tutorial-card">
        <h2 id="tutorial-title" className="tutorial-card-title">
          TUTORIAL
        </h2>
        <p className="tutorial-card-body">{config.body}</p>
        <button type="button" className="tutorial-card-button" onClick={() => advanceTutorial()}>
          {config.sectionEnd ? 'RESUME PLAY' : 'NEXT'}
        </button>
      </div>
    </div>
  );
};
