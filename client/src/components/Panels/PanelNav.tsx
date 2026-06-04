import { useCallback, type ReactNode } from 'react';
import { useGameStore, type PanelIndex } from '../../state/gameStore.js';
import { canNavigateToPanel, type PanelNavContext } from './panelNavigation.js';

const FlowerIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="panel-jump-flower-icon">
    <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    <circle cx="12" cy="5" r="3" fill="currentColor" opacity="0.9" />
    <circle cx="17.5" cy="8.5" r="3" fill="currentColor" opacity="0.9" />
    <circle cx="17.5" cy="15.5" r="3" fill="currentColor" opacity="0.9" />
    <circle cx="12" cy="19" r="3" fill="currentColor" opacity="0.9" />
    <circle cx="6.5" cy="15.5" r="3" fill="currentColor" opacity="0.9" />
    <circle cx="6.5" cy="8.5" r="3" fill="currentColor" opacity="0.9" />
  </svg>
);

interface JumpButtonProps {
  readonly panelIndex: PanelIndex;
  readonly label: string;
  readonly ariaLabel: string;
  readonly placement: 'left' | 'right' | 'top' | 'bottom' | 'center';
  readonly active: boolean;
  readonly enabled: boolean;
  readonly onPress: () => void;
  readonly children?: ReactNode;
}

const JumpButton = ({
  panelIndex,
  label,
  ariaLabel,
  placement,
  active,
  enabled,
  onPress,
  children,
}: JumpButtonProps) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    aria-label={ariaLabel}
    className={`panel-jump panel-jump--${placement}`}
    data-panel-index={panelIndex}
    data-active={active}
    data-enabled={enabled}
    disabled={!enabled}
    onClick={onPress}
  >
    {children ?? label}
  </button>
);

/** Labeled panel jump controls (hive, flowers, rivals). */
export const PanelNav = () => {
  const panel = useGameStore((s) => s.panel);
  const setPanel = useGameStore((s) => s.setPanel);
  const rivalCount = useGameStore((s) => s.world.opponents.length);
  const ctx: PanelNavContext = { rivalCount };

  const navigate = useCallback(
    (next: PanelIndex) => {
      if (!canNavigateToPanel(next, ctx)) return;
      setPanel(next);
    },
    [ctx, setPanel],
  );

  const showTopRival = rivalCount >= 2;
  const showBottomRival = rivalCount >= 3;
  const rivalRightLabel = rivalCount > 1 ? 'RIVAL' : 'RIVAL HIVE';

  return (
    <nav
      className="panel-nav-cluster"
      aria-label="Panel navigation"
      data-tutorial-target="panel-nav"
      data-rival-tier={rivalCount >= 3 ? '3' : rivalCount >= 2 ? '2' : rivalCount >= 1 ? '1' : '0'}
      role="tablist"
    >
      {showTopRival ? (
        <JumpButton
          panelIndex={3}
          label="RIVAL (above)"
          ariaLabel="Rival hive above"
          placement="top"
          active={panel === 3}
          enabled={canNavigateToPanel(3, ctx)}
          onPress={() => navigate(3)}
        />
      ) : null}
      <div className="panel-nav-middle">
        <JumpButton
          panelIndex={0}
          label="YOUR HIVE"
          ariaLabel="Your hive"
          placement="left"
          active={panel === 0}
          enabled
          onPress={() => navigate(0)}
        />
        <JumpButton
          panelIndex={1}
          label="Flowers"
          ariaLabel="Flower field"
          placement="center"
          active={panel === 1}
          enabled
          onPress={() => navigate(1)}
        >
          <FlowerIcon />
        </JumpButton>
        <JumpButton
          panelIndex={2}
          label={rivalRightLabel}
          ariaLabel="Rival hive on the right"
          placement="right"
          active={panel === 2}
          enabled={canNavigateToPanel(2, ctx)}
          onPress={() => navigate(2)}
        />
      </div>
      {showBottomRival ? (
        <JumpButton
          panelIndex={4}
          label="RIVAL (below)"
          ariaLabel="Rival hive below"
          placement="bottom"
          active={panel === 4}
          enabled={canNavigateToPanel(4, ctx)}
          onPress={() => navigate(4)}
        />
      ) : null}
    </nav>
  );
};
