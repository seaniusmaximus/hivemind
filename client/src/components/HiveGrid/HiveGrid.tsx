import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  letterValue,
  queenAllowanceFor,
  queenAssaultHighlightHex,
  remainingHpForTile,
  resolveWordFromPath,
  specialTileIcon,
  tileHasDraftableContent,
  tileShowsSpecialIcon,
  type Hex,
  type PlayerState,
  type TileSnapshot,
} from '@hivemind/shared';
import type { BeePanel } from '@hivemind/shared';
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
  /** Local player hive (panel 0). */
  side?: 'self';
  /** Index into `world.opponents` for rival full-board panels (2–4). */
  opponentIndex?: number;
}

const OPPONENT_PANELS: readonly BeePanel[] = [
  'opponent-hive-right',
  'opponent-hive-above',
  'opponent-hive-below',
];

type DragMode = 'word-draft' | 'letter-move' | null;

type PositionedTile = TileSnapshot & {
  pixel: { x: number; y: number };
  isFrontier: boolean;
};

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

/**
 * Deterministic hash (FNV-1a-ish) of a string to a 32-bit uint — used to seed
 * per-hex crack patterns so each hex gets its own unique-looking fractures.
 */
const hashStr = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Generate deterministic crack-line SVG path data for a damaged hex.
 *  `severity` 1–4+ controls how many cracks are drawn. */
const crackPaths = (key: string, size: number, severity: number): string[] => {
  const seed = hashStr(key);
  const rng = (i: number) => {
    let x = seed ^ (i * 2654435761);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 13), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
  };
  const count = Math.min(severity, 5);
  const paths: string[] = [];
  for (let c = 0; c < count; c++) {
    const angle = rng(c * 7) * Math.PI * 2;
    const r0 = size * (0.12 + rng(c * 7 + 1) * 0.25);
    const r1 = size * (0.55 + rng(c * 7 + 2) * 0.35);
    const x0 = Math.cos(angle) * r0;
    const y0 = Math.sin(angle) * r0;
    const x1 = Math.cos(angle) * r1;
    const y1 = Math.sin(angle) * r1;
    const mx = (x0 + x1) / 2 + (rng(c * 7 + 3) - 0.5) * size * 0.28;
    const my = (y0 + y1) / 2 + (rng(c * 7 + 4) - 0.5) * size * 0.28;
    paths.push(`M${x0.toFixed(1)},${y0.toFixed(1)} L${mx.toFixed(1)},${my.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`);
    if (severity > 2 && rng(c * 7 + 5) > 0.4) {
      const bAngle = angle + (rng(c * 7 + 6) - 0.5) * 1.2;
      const bLen = size * (0.2 + rng(c * 7 + 5) * 0.2);
      const bx = mx + Math.cos(bAngle) * bLen;
      const by = my + Math.sin(bAngle) * bLen;
      paths.push(`M${mx.toFixed(1)},${my.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}`);
    }
  }
  return paths;
};

/** Placeholder for unused rival panels (2–3 player); keeps hook order stable. */
const EMPTY_RIVAL: PlayerState = {
  id: '__empty__',
  honey: 0,
  tiles: [],
  bees: [],
  usedWordSignatures: [],
  bestWord: '',
  bestWordScore: 0,
};

export const HiveGrid = ({ side, opponentIndex = 0 }: Props) => {
  const isSelf = side === 'self';
  const rival = useGameStore((s) => (isSelf ? undefined : s.world.opponents[opponentIndex]));
  const player = useGameStore((s) =>
    isSelf ? s.world.self : (s.world.opponents[opponentIndex] ?? EMPTY_RIVAL),
  );
  const isEmptySlot = !isSelf && rival === undefined;
  const eliminatedPlayerIds = useGameStore((s) => s.world.eliminatedPlayerIds);
  const isEliminatedRival =
    !isSelf && rival !== undefined && eliminatedPlayerIds.includes(rival.id);
  const tiles = player.tiles;
  const drafts = useGameStore((s) => s.wordDrafts);
  const letterDrag = useGameStore((s) => (isSelf ? s.letterDrag : null));
  const dropHover = useGameStore((s) => (isSelf ? s.dropHover : null));
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
    isSelf ? { canStart: canStartHold } : {},
  );

  const {
    hold: workerHold,
    rejection: workerRejection,
    start: startWorkerHold,
    cancel: cancelWorkerHold,
  } = useHoldToDispatch(
    dispatchWorker,
    isSelf
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
  const tileByKeyRef = useRef(new Map<string, PositionedTile>());
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  const resolveDropHoverFromPointer = useCallback((clientX: number, clientY: number): Hex | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const hits = document.elementsFromPoint(clientX, clientY);
    for (const el of hits) {
      const path = el.closest<SVGPathElement>('.hex-tile[data-drop-target]');
      if (!path || !svg.contains(path)) continue;
      const key = path.dataset.hexKey;
      if (!key) continue;
      const tile = tileByKeyRef.current.get(key);
      if (
        !tile ||
        tile.letter ||
        tile.specialKind ||
        (tile.state !== 'active' && tile.state !== 'storage')
      ) {
        continue;
      }
      return tile.hex;
    }
    return null;
  }, []);

  // Drop-hover must follow letter-drag state — never leave cyan highlights orphaned.
  useEffect(() => {
    if (!letterDrag) {
      setDropHover(null);
      if (dragModeRef.current === 'letter-move') dragModeRef.current = null;
    }
  }, [letterDrag, setDropHover]);

  // Track drop target from pointer position (per-tile pointerleave is unreliable).
  useEffect(() => {
    if (!letterDrag || !isSelf) return;

    const syncHover = (e: PointerEvent) => {
      if (!useGameStore.getState().letterDrag) {
        setDropHover(null);
        return;
      }
      setDropHover(resolveDropHoverFromPointer(e.clientX, e.clientY));
    };

    const clearHoverAndHolds = () => {
      setDropHover(null);
      cancelHold();
      cancelWorkerHold();
    };

    window.addEventListener('pointermove', syncHover);
    window.addEventListener('lostpointercapture', clearHoverAndHolds);
    const svg = svgRef.current;
    svg?.addEventListener('pointerleave', clearHoverAndHolds);
    return () => {
      window.removeEventListener('pointermove', syncHover);
      window.removeEventListener('lostpointercapture', clearHoverAndHolds);
      svg?.removeEventListener('pointerleave', clearHoverAndHolds);
      setDropHover(null);
    };
  }, [
    letterDrag,
    isSelf,
    setDropHover,
    resolveDropHoverFromPointer,
    cancelHold,
    cancelWorkerHold,
  ]);

  // End any in-progress drag on pointer up anywhere in the document.
  useEffect(() => {
    const up = () => {
      pendingLetterAnchorRef.current = null;
      if (dragModeRef.current === 'letter-move') {
        commitLetterDrag();
      } else if (dragModeRef.current === 'word-draft') {
        endDraft();
      } else if (useGameStore.getState().letterDrag) {
        cancelLetterDrag();
      }
      dragModeRef.current = null;
    };
    const cancel = () => {
      pendingLetterAnchorRef.current = null;
      if (dragModeRef.current === 'letter-move') cancelLetterDrag();
      else if (dragModeRef.current === 'word-draft') endDraft();
      else if (useGameStore.getState().letterDrag) cancelLetterDrag();
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
  const floatingLetters = player.freedLetters ?? [];
  const frontier = useMemo(() => frontierFor(player), [player]);
  const ownedKeys = useMemo(() => new Set(tiles.map((t) => hexKey(t.hex))), [tiles]);

  const positioned = useMemo((): PositionedTile[] => {
    const base: PositionedTile[] = tiles.map((t) => ({
      ...t,
      pixel: axialToPixel(t.hex, HEX_SIZE),
      isFrontier: false,
    }));
    const front: PositionedTile[] = frontier
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
    if (!isSelf) return new Set<string>();
    const set = new Set<string>();
    for (const h of frontier) set.add(hexKey(h));
    for (const t of tiles) if (t.state === 'inactive') set.add(hexKey(t.hex));
    return set;
  }, [tiles, frontier, isSelf]);

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
  const claimOwner = isSelf ? 'self' : 'opp';
  // `player === world[side]` so this checks the right side either way; the
  // central-hive click only fires for `side === 'self'` below.
  const queensActive = activeQueenCountFor(player);
  const queenAllowance = queenAllowanceFor(player);
  const queensFull = queensActive >= queenAllowance;
  const hiveLargeEnoughForQueen = player.tiles.length >= QUEEN_MIN_OWNED_HEXES;
  const canSpawnQueen =
    isSelf &&
    honey >= queenCost &&
    !queensFull &&
    hiveLargeEnoughForQueen;
  const floatingByHex = useMemo(
    () => new Map(floatingLetters.map((f) => [hexKey(f.hex), f])),
    [floatingLetters],
  );

  /** Defender tiles where an enemy queen is currently inbound (queen-flying). */
  const opponents = useGameStore((s) => s.world.opponents);
  const selfBeesForIncoming = useGameStore((s) => s.world.self.bees);
  const attackerBees = useMemo(
    () => (isSelf ? opponents.flatMap((o) => o.bees) : selfBeesForIncoming),
    [isSelf, opponents, selfBeesForIncoming],
  );
  const incomingQueenHexKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const b of attackerBees) {
      if (b.kind === 'queen' && b.state.kind === 'queen-flying') {
        keys.add(hexKey(queenAssaultHighlightHex(player, b.state.landingHex)));
      }
    }
    return keys;
  }, [attackerBees, player]);

  const allHexes = useMemo(() => positioned.map((t) => t.hex), [positioned]);
  const extent = useMemo(
    () => centeredViewBoxExtent(allHexes, HEX_SIZE),
    [allHexes],
  );
  const viewBox = `${-extent.halfWidth} ${-extent.halfHeight} ${extent.halfWidth * 2} ${extent.halfHeight * 2}`;

  useEffect(() => {
    const panel: BeePanel = isSelf
      ? 'self-hive'
      : (OPPONENT_PANELS[opponentIndex] ?? 'opponent-hive-right');
    registerGrid(panel, {
      el: svgRef.current,
      viewBoxHalfWidth: extent.halfWidth,
      viewBoxHalfHeight: extent.halfHeight,
      hexSize: HEX_SIZE,
    });
    return () => unregisterGrid(panel);
  }, [isSelf, opponentIndex, extent.halfWidth, extent.halfHeight]);

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

  const interactive = isSelf;

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
      (tile.state === 'active' || tile.state === 'letter') &&
      (!!tile.letter || !!tile.specialKind);
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
    if (tile.state === 'storage' && (tile.letter || tile.specialKind)) {
      dragModeRef.current = 'letter-move';
      startLetterDrag(h);
      return;
    }
    if (tile.state === 'capped') {
      dragModeRef.current = 'word-draft';
      if (useGameStore.getState().letterDrag) cancelLetterDrag();
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
        (tile.state === 'active' && !tile.letter && !tile.specialKind) ||
        (tile.state === 'storage' && !tile.letter && !tile.specialKind);
      setDropHover(isDropSlot ? h : null);
      return;
    }
    if (dragModeRef.current === 'word-draft') {
      if (tileHasDraftableContent(tile)) extendDraft(h);
      return;
    }
    const anchor = pendingLetterAnchorRef.current;
    if (anchor !== null && !hexEquals(anchor, h)) {
      const tileA = tiles.find((t) => hexEquals(t.hex, anchor));
      const canLiftFromComb =
        !!(tileA?.letter || tileA?.specialKind) &&
        (tileA.state === 'active' || tileA.state === 'letter');
      const isDropSlot =
        (tile.state === 'active' && !tile.letter && !tile.specialKind) ||
        (tile.state === 'storage' && !tile.letter && !tile.specialKind);
      if (canLiftFromComb && isDropSlot) {
        pendingLetterAnchorRef.current = null;
        startLetterDrag(anchor);
        dragModeRef.current = 'letter-move';
        setDropHover(h);
        return;
      }
      if (canLiftFromComb && tileHasDraftableContent(tile) && isAdjacent(anchor, h)) {
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

  tileByKeyRef.current = new Map(positioned.map((t) => [hexKey(t.hex), t]));

  if (isEmptySlot) {
    return (
      <div className="hive-grid hive-grid--empty">
        <p className="hive-grid-empty-label">No rival in this slot</p>
      </div>
    );
  }

  return (
    <div
      className={[
        'grid-frame',
        'grid-frame--hive',
        isEliminatedRival ? 'grid-frame--rival-eliminated' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h2 className="hud-title grid-heading">
        {isSelf ? 'YOUR HIVE' : isEliminatedRival ? 'RIVAL HIVE (eliminated)' : 'RIVAL HIVE'}
      </h2>
      {isSelf ? (
        <p className="grid-subtitle">
          hold a frontier tile {holdSeconds}s to build · {carpenterCost}🜨
        </p>
      ) : (
        <p className="grid-subtitle grid-subtitle--reserve" aria-hidden="true">
          {' '}
        </p>
      )}
      <div className="panel-nav-spacer" aria-hidden="true" />
      <div ref={canvasRef} className="hive-field-canvas hive-field-canvas--zoomable" data-tutorial-target="hive-grid">
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
            ((t.state === 'active' && !t.letter && !t.specialKind) ||
              (t.state === 'storage' && !t.letter && !t.specialKind));
          const isDropHover =
            isDropTarget &&
            dropHover !== null &&
            hexEquals(dropHover, t.hex);
          const hideLetter = draggingFromKey === k;
          const reuseCount = t.reuseCount ?? 0;
          const hp = hexHpForTile(t);
          const damage = t.damage ?? 0;
          const remaining = remainingHpForTile(t);
          const isDamaged = damage > 0 && remaining > 0;
          const crackSeverity = isDamaged ? Math.ceil(damage * 2) : 0;
          // Each reuse adds 0.5 HP of armor (one ring). Queen strikes deal 1 HP,
          // so each hit peels two rings. Rings peel from the outside in.
          const reuseLevel = Math.max(0, reuseCount - Math.floor(damage * 2));
          const showSpecialIcon = tileShowsSpecialIcon(t);
          const interactiveTile =
            interactive &&
            ((t.state === 'storage' && (!!t.letter || !!t.specialKind)) ||
              (t.state === 'active' && (!!t.letter || !!t.specialKind)) ||
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
                data-tutorial-target={
                  t.state === 'hive'
                    ? 'hive-center'
                    : t.state === 'storage'
                      ? 'storage-ring'
                      : undefined
                }
                data-uncapped-letter={
                  t.state === 'active' && (!!t.letter || !!t.specialKind) ? true : undefined
                }
                data-filled={t.state === 'storage' && (!!t.letter || !!t.specialKind)}
                data-special={t.specialKind ?? undefined}
                data-draft={drafted}
                data-draft-idx={draftIdx ?? undefined}
                data-carpenter-eligible={isCarpenterEligible}
                data-holding={isHeld}
                data-hex-key={k}
                data-drop-target={isDropTarget || undefined}
                data-drop-hover={isDropHover || undefined}
                data-interactive={interactiveTile}
                data-reuse-level={reuseLevel}
                data-hp={hp}
                data-damaged={isDamaged ? true : undefined}
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
              {crackSeverity > 0 &&
                crackPaths(k, tileSize, crackSeverity).map((cp, ci) => (
                  <path
                    key={`crack-${ci}`}
                    d={cp}
                    className="hex-crack"
                    pointerEvents="none"
                  />
                ))}
              {t.state === 'hive' && (
                <path
                  className="hive-door"
                  d={hexPath(tileSize * HIVE_DOOR_HEX_FR)}
                  transform={`translate(0,${tileSize * (1 - HIVE_DOOR_HEX_FR - HIVE_DOOR_UPSHIFT_FR)})`}
                  pointerEvents="none"
                />
              )}
              {t.state === 'hive' && (
                <text
                  className="hive-honey"
                  x={0}
                  y={0}
                  {...(isSelf ? { 'data-tutorial-target': 'honey-label' } : {})}
                >
                  {Math.floor(player.honey)}
                </text>
              )}
              {t.state === 'hive' && canSpawnQueen && (
                <text className="queen-ready-glyph" x={0} y={-19}>
                  👑
                </text>
              )}
              {showSpecialIcon && t.specialKind && !hideLetter && (
                <text className="hex-letter special-tile-icon" x={0} y={0}>
                  {specialTileIcon(t.specialKind)}
                </text>
              )}
              {t.letter && !hideLetter && (
                <>
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
                  {t.state === 'storage' && (
                    <text
                      className="hex-letter-points storage-letter-points"
                      x={0}
                      y={tileSize * 0.52}
                    >
                      {letterValue(t.letter)}
                    </text>
                  )}
                </>
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
