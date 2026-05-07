import { useEffect, useRef, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { useGameStore, type PanelIndex } from '../../state/gameStore.js';

interface Props {
  children: readonly ReactNode[];
}

const PANEL_LABELS = ['YOUR HIVE', 'FLOWERS', 'OPPONENT'] as const;

export const PanelDeck = ({ children }: Props) => {
  const panel = useGameStore((s) => s.panel);
  const setPanel = useGameStore((s) => s.setPanel);
  const trackRef = useRef<HTMLDivElement | null>(null);

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
      <div className="panel-deck">
        <div
          ref={trackRef}
          style={{ display: 'flex', width: '300%', height: '100%' }}
        >
          {children.map((child, i) => (
            <div className="panel" key={i} role="tabpanel">
              {child}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
