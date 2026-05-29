import { useGameStore } from '../../state/gameStore.js';
import {
  applyPanelDirection,
  panelGoDown,
  panelGoLeft,
  panelGoRight,
  panelGoUp,
  type PanelNavContext,
} from './panelNavigation.js';

const ChevronLeft = () => (
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
);

const ChevronRight = () => (
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
);

const ChevronUp = () => (
  <svg viewBox="0 0 24 12" aria-hidden focusable="false">
    <polyline
      points="3,9 12,3 21,9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ChevronDown = () => (
  <svg viewBox="0 0 24 12" aria-hidden focusable="false">
    <polyline
      points="3,3 12,9 21,3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface NavButtonProps {
  readonly dir: 'left' | 'right' | 'up' | 'down';
  readonly label: string;
  readonly tutorialTarget: string;
  readonly onPress: () => void;
  readonly canPress: boolean;
}

const NavButton = ({ dir, label, tutorialTarget, onPress, canPress }: NavButtonProps) => (
  <button
    type="button"
    className={`panel-nav-btn panel-nav-btn--${dir}`}
    data-tutorial-target={tutorialTarget}
    aria-label={label}
    onClick={onPress}
    data-available={canPress}
  >
    {dir === 'left' && <ChevronLeft />}
    {dir === 'right' && <ChevronRight />}
    {dir === 'up' && <ChevronUp />}
    {dir === 'down' && <ChevronDown />}
  </button>
);

/** Fixed top-right D-pad for cross-shaped panel navigation. */
export const PanelNav = () => {
  const panel = useGameStore((s) => s.panel);
  const setPanel = useGameStore((s) => s.setPanel);
  const rivalCount = useGameStore((s) => s.world.opponents.length);
  const ctx: PanelNavContext = { rivalCount };

  const press = (dir: 'left' | 'right' | 'up' | 'down') => {
    const next = applyPanelDirection(panel, dir, ctx);
    if (next !== null) setPanel(next);
  };

  return (
    <nav className="panel-nav" aria-label="Panel navigation" data-tutorial-target="panel-nav">
      <NavButton
        dir="up"
        label="Rival hive above"
        tutorialTarget="panel-arrow-up"
        onPress={() => press('up')}
        canPress={panelGoUp(panel, ctx) !== null}
      />
      <NavButton
        dir="left"
        label="Your hive"
        tutorialTarget="panel-arrow-left"
        onPress={() => press('left')}
        canPress={panelGoLeft(panel, ctx) !== null}
      />
      <NavButton
        dir="right"
        label="Rival hive on the right"
        tutorialTarget="panel-arrow-right"
        onPress={() => press('right')}
        canPress={panelGoRight(panel, ctx) !== null}
      />
      <NavButton
        dir="down"
        label="Rival hive below"
        tutorialTarget="panel-arrow-down"
        onPress={() => press('down')}
        canPress={panelGoDown(panel, ctx) !== null}
      />
    </nav>
  );
};
