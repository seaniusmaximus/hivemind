import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  activeQueenCountFor,
  axialToPixel,
  BEE_STATS,
  QUEEN_MIN_OWNED_HEXES,
  frontierFor,
  hexEquals,
  hexHpForTile,
  hexKey,
  isAdjacent,
  queenAllowanceFor,
  tileHasDraftableLetter,
  type Hex,
  type Side,
  type TileSnapshot,
} from '@hivemind/shared';
import { useGameStore, draftKeySet } from '../../state/gameStore.js';
import {
  centeredViewBoxExtent,
  HIVE_DOOR_HEX_FR,
  HIVE_DOOR_UPSHIFT_FR,
  HIVE_HEX_DRAW_SCALE,
  registerGrid,
  unregisterGrid,
} from '../../game/layout.js';
import { HOLD_HINT_SECONDS, useHoldToDispatch } from '../useHoldToDispatch.js';

interface Props {
  side: Side;
  /** Rendered under the hive title (e.g. honey cap from {@link PlayerPanel}). */
  honeyLabel?: ReactNode;
}

const HEX_SIZE = 30;
const REUSE_RING_STEP = 4;
const MIN_RING_SIZE = 8;

/** Visual scale: 1 = default; >1 zooms in without narrowing the viewBox (no crop). */
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.75;
const WHEEL_ZOOM_SENS = 0.0014;

/** Hex path starting at the upper-right vertex (used for tile fills). */
const hexPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

/** Hex path starting at the *top* vertex and going clockwise — used for the
 *  hold border so the line draws downward from 12 o'clock. */
const holdBorderPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

type DragMode = 'word-draft' | 'letter-move' | null;

export const HiveGrid = ({ side, honeyLabel }: Props) => {
  const tiles = useGameStore((s) => s.world[side].tiles);
  const drafts = useGameStore((s) => s.wordDrafts);
  const letterDrag = useGameStore((s) => (side === 'self' ? s.letterDrag : null));
  const dropHover = useGameStore((s) => (side === 'self' ? s.dropHover : null));
  const startDraft = useGameStore((s) => s.startDraft);
  const extendDraft = useGameStore((s) => s.extendDraft);
  const endDraft = useGameStore((s) => s.endDraft);
  const startLetterDrag = useGameStore((s) => s.startLetterDrag);
  const setDropHover = useGameStore((s) => s.setDropHover);
  const commitLetterDrag = useGameStore((s) => s.commitLetterDrag);
  const cancelLetterDrag = useGameStore((s) => s.cancelLetterDrag);
  const dispatchCarpenter = useGameStore((s) => s.dispatchCarpenter);
  const dispatchWorker = useGameStore((s) => s.dispatchWorker);
  const dispatchQueen = useGameStore((s) => s.dispatchQueen);
  const cancelQueenTargeting = useGameStore((s) => s.cancelQueenTargeting);
  const queenTargeting = useGameStore((s) => s.queenTargeting);
  const pushToast = useGameStore((s) => s.pushToast);
  const honey = useGameStore((s) => s.world.self.honey);

  const carpenterCost = BEE_STATS.carpenter.honeyCost;
  const workerCost = BEE_STATS.worker.honeyCost;
  const queenCost = BEE_STATS.queen.honeyCost;
  // Read the latest honey via a ref so the predicate sees current state.
  const honeyRef = useRef(honey);
  honeyRef.current = honey;
  const canStartHold = useCallback(
    (h: Hex) => {
      if (honeyRef.current < carpenterCost) {
        pushToast({ text: 'not enough honey', panel: 'self-hive', hex: h, variant: 'error' });
        return false;
      }
      return true;
    },
    [carpenterCost, pushToast],
  );

  const {
    hold,
    rejection,
    start: startHold,
    cancel: cancelHold,
  } = useHoldToDispatch(
    dispatchCarpenter,
    side === 'self' ? { canStart: canStartHold } : {},
  );

  const {
    hold: workerHold,
    rejection: workerRejection,
    start: startWorkerHold,
    cancel: cancelWorkerHold,
  } = useHoldToDispatch(
    dispatchWorker,
    side === 'self'
      ? {
          canStart: (h) => {
            if (honeyRef.current < workerCost) {
              pushToast({ text: 'not enough honey', panel: 'self-hive', hex: h, variant: 'error' });
              return false;
            }
            return true;
          },
        }
      : {},
  );

  const dragModeRef = useRef<DragMode>(null);
  /** Uncapped comb letter: pointerdown sets anchor; first `pointerenter` elsewhere picks letter-move vs word-draft. */
  const pendingLetterAnchorRef = useRef<Hex | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  // End any in-progress drag on pointer up anywhere in the document.
  useEffect(() => {
    const up = () => {
      pendingLetterAnchorRef.current = null;
      if (dragModeRef.current === 'letter-move') {
        commitLetterDrag();
      } else if (dragModeRef.current === 'word-draft') {
        endDraft();
      }
      dragModeRef.current = null;
    };
    const cancel = () => {
      pendingLetterAnchorRef.current = null;
      if (dragModeRef.current === 'letter-move') cancelLetterDrag();
      else if (dragModeRef.current === 'word-draft') endDraft();
      dragModeRef.current = null;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [commitLetterDrag, cancelLetterDrag, endDraft]);

  // Frontier = derived inactive hexes around your active/letter/capped tiles.
  // Folded in alongside the owned tiles so the renderer can treat both
  // uniformly. Re-derived whenever the player's tile set changes.
  const player = useGameStore((s) => s.world[side]);
  const floatingLetters = player.freedLetters ?? [];
  const frontier = useMemo(() => frontierFor(player), [player]);
  const ownedKeys = useMemo(() => new Set(tiles.map((t) => hexKey(t.hex))), [tiles]);

  const positioned = useMemo(() => {
    const base = tiles.map((t: TileSnapshot) => ({
      ...t,
      pixel: axialToPixel(t.hex, HEX_SIZE),
      isFrontier: false,
    }));
    const front = frontier
      .filter((h) => !ownedKeys.has(hexKey(h)))
      .map((h) => ({
        hex: h,
        state: 'inactive' as const,
        letter: null,
        reuseCount: 0,
        damage: 0,
        pixel: axialToPixel(h, HEX_SIZE),
        isFrontier: true,
      }));
    return [...base, ...front];
  }, [tiles, frontier, ownedKeys]);

  const draftIndexByKey = useMemo(
    () => (side === 'self' ? draftKeySet(drafts) : new Map<string, number>()),
    [drafts, side],
  );

  // Eligible carpenter targets: every visible inactive hex (the frontier set is
  // already the eligibility set). Plus any legacy `inactive` owned tile.
  const eligibleCarpenter = useMemo(() => {
    if (side !== 'self') return new Set<string>();
    const set = new Set<string>();
    for (const h of frontier) set.add(hexKey(h));
    for (const t of tiles) if (t.state === 'inactive') set.add(hexKey(t.hex));
    return set;
  }, [tiles, frontier, side]);

  // Hexes currently being targeted by an in-flight carpenter for *this* side.
  // Persists the outline drawn during the hold gesture for the full duration
  // of the carpenter's flight, so the player can see at a glance which builds
  // are committed.
  const carpenterClaims = useMemo(() => {
    const set = new Set<string>();
    for (const bee of player.bees) {
      if (bee.state.kind === 'carpenter-flying') {
        set.add(hexKey(bee.state.target));
        for (const qh of bee.state.queue) {
          set.add(hexKey(qh));
        }
      }
    }
    return set;
  }, [player.bees]);
  const claimOwner = side === 'self' ? 'self' : 'opp';
  // `player === world[side]` so this checks the right side either way; the
  // central-hive click only fires for `side === 'self'` below.
  const queensActive = activeQueenCountFor(player);
  const queenAllowance = queenAllowanceFor(player);
  const queensFull = queensActive >= queenAllowance;
  const hiveLargeEnoughForQueen = player.tiles.length >= QUEEN_MIN_OWNED_HEXES;
  const canSpawnQueen =
    side === 'self' &&
    honey >= queenCost &&
    !queensFull &&
    hiveLargeEnoughForQueen;
  const floatingByHex = useMemo(
    () => new Map(floatingLetters.map((f) => [hexKey(f.hex), f])),
    [floatingLetters],
  );

  /** Defender tiles where an enemy queen is currently inbound (queen-flying). */
  const attackerBees = useGameStore((s) => s.world[side === 'opponent' ? 'self' : 'opponent'].bees);
  const incomingQueenHexKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const b of attackerBees) {
      if (b.kind === 'queen' && b.state.kind === 'queen-flying') {
        keys.add(hexKey(b.state.landingHex));
      }
    }
    return keys;
  }, [attackerBees]);

  const allHexes = useMemo(() => positioned.map((t) => t.hex), [positioned]);
  const extent = useMemo(
    () => centeredViewBoxExtent(allHexes, HEX_SIZE),
    [allHexes],
  );
  const viewBox = `${-extent.halfWidth} ${-extent.halfHeight} ${extent.halfWidth * 2} ${extent.halfHeight * 2}`;

  useEffect(() => {
    const panel = side === 'self' ? 'self-hive' : 'opponent-hive';
    registerGrid(panel, {
      el: svgRef.current,
      viewBoxHalfWidth: extent.halfWidth,
      viewBoxHalfHeight: extent.halfHeight,
      hexSize: HEX_SIZE,
    });
    return () => unregisterGrid(panel);
  }, [side, extent.halfWidth, extent.halfHeight]);

  // Wheel zoom (desktop / trackpad); non-passive so we can prevent page scroll.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENS);
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pinch zoom on touch devices.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const pinch = { startDist: 0, startZoom: 1, active: false };
    const dist = (e: TouchEvent) => {
      if (e.touches.length < 2) return 0;
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const d = dist(e);
        if (d > 0) {
          pinch.startDist = d;
          pinch.startZoom = zoomRef.current;
          pinch.active = true;
        }
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch.active || e.touches.length < 2) return;
      e.preventDefault();
      const d = dist(e);
      if (d <= 0 || pinch.startDist < 8) return;
      const z = pinch.startZoom * (d / pinch.startDist);
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch.active = false;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const interactive = side === 'self';

  const handlePointerDown = (
    e: React.PointerEvent<SVGPathElement>,
    h: Hex,
    tile: TileSnapshot,
  ) => {
    if (!interactive) return;
    // Touch devices implicitly capture the pointer to the originating element
    // on `pointerdown`, which retargets every subsequent pointer event back to
    // this tile and breaks cross-hex drags (word drafting, letter placing).
    // Releasing the capture lets `pointerenter`/`pointerleave` fire on the
    // tile actually under the finger.
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // No active capture — ignore.
    }
    const uncappedCombLetter =
      (tile.state === 'active' || tile.state === 'letter') && !!tile.letter;
    if (!uncappedCombLetter) {
      pendingLetterAnchorRef.current = null;
    }
    if (tile.state === 'hive') {
      // Already in targeting mode? Treat clicking your own hive as a cancel
      // so the player has an obvious back-out gesture.
      if (queenTargeting) {
        cancelQueenTargeting();
        return;
      }
      // Click-the-crown: same queen flow as the spawn banner (mini-board side pick).
      if (player.tiles.length < QUEEN_MIN_OWNED_HEXES) {
        pushToast({
          text: `queen unlocks at ${QUEEN_MIN_OWNED_HEXES} hive hexes (${player.tiles.length} now)`,
          panel: 'self-hive',
          hex: h,
          variant: 'error',
        });
        return;
      }
      if (honeyRef.current < queenCost) {
        pushToast({ text: 'not enough honey', panel: 'self-hive', hex: h, variant: 'error' });
        return;
      }
      if (queensFull) {
        pushToast({
          text: `queen allowance full (${queensActive}/${queenAllowance})`,
          panel: 'self-hive',
          hex: h,
          variant: 'error',
        });
        return;
      }
      dispatchQueen('self');
      return;
    }
    if (tile.state === 'storage' && tile.letter) {
      dragModeRef.current = 'letter-move';
      startLetterDrag(h);
      return;
    }
    if (tile.state === 'capped') {
      dragModeRef.current = 'word-draft';
      startDraft(h);
      return;
    }
    if (uncappedCombLetter) {
      pendingLetterAnchorRef.current = h;
      return;
    }
    const floating = floatingByHex.get(hexKey(h));
    if (floating) {
      startWorkerHold(h);
      return;
    }
    if (eligibleCarpenter.has(hexKey(h))) {
      // Hold-to-build: a 1-second press dispatches a carpenter to this hex.
      startHold(h);
    }
  };

  const handlePointerEnter = (h: Hex, tile: TileSnapshot) => {
    if (!interactive) return;
    if (dragModeRef.current === 'letter-move') {
      const isDropSlot =
        (tile.state === 'active' && !tile.letter) ||
        (tile.state === 'storage' && !tile.letter);
      setDropHover(isDropSlot ? h : null);
      return;
    }
    if (dragModeRef.current === 'word-draft') {
      if (tileHasDraftableLetter(tile)) extendDraft(h);
      return;
    }
    const anchor = pendingLetterAnchorRef.current;
    if (anchor !== null && !hexEquals(anchor, h)) {
      const tileA = tiles.find((t) => hexEquals(t.hex, anchor));
      const canLiftFromComb =
        !!tileA?.letter && (tileA.state === 'active' || tileA.state === 'letter');
      const isDropSlot =
        (tile.state === 'active' && !tile.letter) ||
        (tile.state === 'storage' && !tile.letter);
      if (canLiftFromComb && isDropSlot) {
        pendingLetterAnchorRef.current = null;
        startLetterDrag(anchor);
        dragModeRef.current = 'letter-move';
        setDropHover(h);
        return;
      }
      if (canLiftFromComb && tileHasDraftableLetter(tile) && isAdjacent(anchor, h)) {
        pendingLetterAnchorRef.current = null;
        startDraft(anchor);
        extendDraft(h);
        dragModeRef.current = 'word-draft';
      }
    }
  };

  const handlePointerLeave = (h: Hex) => {
    if (!interactive) return;
    cancelHold(h);
    cancelWorkerHold(h);
    if (dragModeRef.current === 'letter-move' && dropHover && hexEquals(dropHover, h)) {
      setDropHover(null);
    }
  };

  const handlePointerUp = (h: Hex) => {
    if (!interactive) return;
    cancelHold(h);
    cancelWorkerHold(h);
  };

  // While a letter drag is active, the source hex renders without its letter
  // (it rides the pointer-following ghost).
  const draggingFromKey = letterDrag ? hexKey(letterDrag.fromHex) : null;

  const holdSeconds = HOLD_HINT_SECONDS;

  return (
    <div className="grid-frame grid-frame--hive">
      <h2 className="hud-title grid-heading">{side === 'self' ? 'YOUR HIVE' : 'RIVAL HIVE'}</h2>
      {side === 'self' && honeyLabel}
      {side === 'self' && (
        <p className="grid-subtitle">
          hold a frontier tile {holdSeconds}s to build · {carpenterCost}🜨
        </p>
      )}
      <div ref={canvasRef} className="hive-field-canvas hive-field-canvas--zoomable">
        <svg
          ref={svgRef}
          className="hex-svg hex-svg--hive"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${side} hive grid`}
          style={{
            touchAction: 'none',
            WebkitTouchCallout: 'none',
            transform: `scale(${zoom})`,
            transformOrigin: 'center center',
            overflow: 'visible',
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
        {positioned.map((t) => {
          const k = hexKey(t.hex);
          const draftIdx = draftIndexByKey.get(k);
          const drafted = draftIdx !== undefined;
          const isCarpenterEligible = eligibleCarpenter.has(k);
          const isHeld = hold.hex !== null && hexEquals(hold.hex, t.hex);
          const isWorkerHeld = workerHold.hex !== null && hexEquals(workerHold.hex, t.hex);
          const isRejected =
            rejection !== null && hexEquals(rejection.hex, t.hex);
          const isWorkerRejected =
            workerRejection !== null && hexEquals(workerRejection.hex, t.hex);
          const floating = floatingByHex.get(k);
          const isClaimed = carpenterClaims.has(k);
          const isDropTarget =
            interactive &&
            !!letterDrag &&
            ((t.state === 'active' && !t.letter) || (t.state === 'storage' && !t.letter));
          const isDropHover =
            isDropTarget &&
            dropHover !== null &&
            hexEquals(dropHover, t.hex);
          const hideLetter = draggingFromKey === k;
          const reuseCount = t.reuseCount ?? 0;
          const hp = hexHpForTile(t);
          // Each capped reuse adds +2 HP and one ring. As the queen damages a
          // tile we peel rings off so the visible borders mirror the tile's
          // remaining HP tier (every 2 damage = one ring lost).
          const reuseLevel = Math.max(0, reuseCount - Math.floor((t.damage ?? 0) / 2));
          const interactiveTile =
            interactive &&
            ((t.state === 'storage' && !!t.letter) ||
              (t.state === 'active' && !!t.letter) ||
              t.state === 'letter' ||
              t.state === 'capped' ||
              isDropTarget ||
              isCarpenterEligible ||
              (t.state === 'hive' && canSpawnQueen));
          const tileSize =
            t.state === 'hive'
              ? HEX_SIZE * HIVE_HEX_DRAW_SCALE
              : t.state === 'storage'
                ? HEX_SIZE * 0.78
                : HEX_SIZE;
          const maxReuseRings = Math.max(
            0,
            Math.floor((tileSize - MIN_RING_SIZE) / REUSE_RING_STEP),
          );
          const visibleReuseRings = Math.min(reuseLevel, maxReuseRings);
          return (
            <g key={k} transform={`translate(${t.pixel.x},${t.pixel.y})`}>
              <path
                d={hexPath(tileSize)}
                className="hex-tile"
                data-state={t.state}
                data-uncapped-letter={t.state === 'active' && !!t.letter ? true : undefined}
                data-filled={t.state === 'storage' && !!t.letter}
                data-draft={drafted}
                data-draft-idx={draftIdx ?? undefined}
                data-carpenter-eligible={isCarpenterEligible}
                data-holding={isHeld}
                data-drop-target={isDropTarget}
                data-drop-hover={isDropHover}
                data-interactive={interactiveTile}
                data-reuse-level={reuseLevel}
                data-hp={hp}
                data-incoming-queen-landing={incomingQueenHexKeys.has(k) ? true : undefined}
                onPointerDown={(e) => handlePointerDown(e, t.hex, t)}
                onPointerEnter={() => handlePointerEnter(t.hex, t)}
                onPointerLeave={() => handlePointerLeave(t.hex)}
                onPointerUp={() => handlePointerUp(t.hex)}
                onPointerCancel={() => handlePointerUp(t.hex)}
              />
              {visibleReuseRings > 0 &&
                Array.from({ length: visibleReuseRings }, (_, idx) => {
                  const ringSize = tileSize - REUSE_RING_STEP * (idx + 1);
                  return (
                    <path
                      key={`reuse-${idx}`}
                      d={hexPath(ringSize)}
                      className="reuse-ring"
                    />
                  );
                })}
              {t.state === 'hive' && (
                <path
                  className="hive-door"
                  d={hexPath(tileSize * HIVE_DOOR_HEX_FR)}
                  transform={`translate(0,${tileSize * (1 - HIVE_DOOR_HEX_FR - HIVE_DOOR_UPSHIFT_FR)})`}
                  pointerEvents="none"
                />
              )}
              {t.state === 'hive' && (
                <text className="hive-honey" x={0} y={0}>
                  {Math.floor(player.honey)}
                </text>
              )}
              {t.state === 'hive' && canSpawnQueen && (
                <text className="queen-ready-glyph" x={0} y={-19}>
                  👑
                </text>
              )}
              {t.letter && !hideLetter && (
                <text
                  className={
                    t.state === 'storage'
                      ? 'hex-letter storage-letter'
                      : t.state === 'capped'
                        ? 'hex-letter capped-letter'
                        : 'hex-letter'
                  }
                  x={0}
                  y={0}
                >
                  {t.letter}
                </text>
              )}
              {floating && (
                <text className="floating-letter" x={0} y={-14}>
                  {floating.letter}
                </text>
              )}
              {isClaimed && !isHeld && (
                <path
                  d={hexPath(tileSize)}
                  className="claim-border"
                  data-owner={claimOwner}
                />
              )}
              {isHeld && (
                <path
                  d={holdBorderPath(tileSize)}
                  className="hold-border"
                  pathLength={100}
                  strokeDasharray={`${(hold.progress * 100).toFixed(2)} 100`}
                />
              )}
              {isWorkerHeld && (
                <path
                  d={holdBorderPath(tileSize)}
                  className="hold-border worker-reclaim-border"
                  pathLength={100}
                  strokeDasharray={`${(workerHold.progress * 100).toFixed(2)} 100`}
                />
              )}
              {isRejected && (
                <path
                  key={rejection.token}
                  d={hexPath(tileSize)}
                  className="hex-reject-flash"
                />
              )}
              {isWorkerRejected && (
                <path
                  key={workerRejection.token}
                  d={hexPath(tileSize)}
                  className="hex-reject-flash"
                />
              )}
            </g>
          );
        })}
        </svg>
      </div>
    </div>
  );
};
