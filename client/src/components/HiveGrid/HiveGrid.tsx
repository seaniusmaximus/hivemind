import { useEffect, useMemo, useRef } from 'react';
import { axialToPixel, hexEquals, hexKey, type Hex, type TileSnapshot } from '@hivemind/shared';
import { useGameStore, draftKeySet } from '../../state/gameStore.js';
import { frontierFor, type Side } from '../../game/engine/state.js';
import {
  centeredViewBoxExtent,
  registerGrid,
  unregisterGrid,
} from '../../game/layout.js';

interface Props {
  side: Side;
}

const HEX_SIZE = 30;

const hexPath = (size: number): string => {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
};

type DragMode = 'word-draft' | 'letter-move' | null;

export const HiveGrid = ({ side }: Props) => {
  const tiles = useGameStore((s) => s.world[side].tiles);
  const playerId = useGameStore((s) => s.world[side].id);
  const carpenterQueue = useGameStore((s) => s.world[side].carpenterQueue);
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
  const toggleCarpenterTarget = useGameStore((s) => s.toggleCarpenterTarget);

  const dragModeRef = useRef<DragMode>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // End any in-progress drag on pointer up anywhere in the document.
  useEffect(() => {
    const up = () => {
      if (dragModeRef.current === 'letter-move') {
        commitLetterDrag();
      } else if (dragModeRef.current === 'word-draft') {
        endDraft();
      }
      dragModeRef.current = null;
    };
    const cancel = () => {
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

  const carpenterIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    carpenterQueue.forEach((h, i) => map.set(hexKey(h), i));
    return map;
  }, [carpenterQueue]);

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

  const interactive = side === 'self';

  const handlePointerDown = (h: Hex, tile: TileSnapshot) => {
    if (!interactive) return;
    if (tile.state === 'storage' && tile.letter) {
      dragModeRef.current = 'letter-move';
      startLetterDrag(h);
      return;
    }
    if (tile.state === 'letter' || tile.state === 'capped') {
      dragModeRef.current = 'word-draft';
      startDraft(h);
      return;
    }
    if (tile.state === 'inactive' && eligibleCarpenter.has(hexKey(h))) {
      // Click toggles the tile in the carpenter queue. No drag.
      toggleCarpenterTarget(h);
    }
  };

  const handlePointerEnter = (h: Hex, tile: TileSnapshot) => {
    if (!interactive) return;
    if (dragModeRef.current === 'letter-move') {
      // Drop target = empty active tile.
      setDropHover(tile.state === 'active' && !tile.letter ? h : null);
      return;
    }
    if (dragModeRef.current === 'word-draft') {
      if (tile.state === 'letter' || tile.state === 'capped') extendDraft(h);
    }
  };

  const handlePointerLeave = (h: Hex) => {
    if (!interactive || dragModeRef.current !== 'letter-move') return;
    if (dropHover && hexEquals(dropHover, h)) {
      setDropHover(null);
    }
  };

  // While the drag is active, the source storage slot renders without its
  // letter (it's "in flight" with the pointer-following ghost).
  const draggingFromKey = letterDrag ? hexKey(letterDrag.fromHex) : null;

  return (
    <div className="grid-frame">
      <h2 className="hud-title grid-heading">
        {side === 'self' ? `HIVE ${playerId.toUpperCase()}` : `RIVAL ${playerId.toUpperCase()}`}
      </h2>
      <svg
        ref={svgRef}
        className="hex-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${side} hive grid`}
        style={{ touchAction: 'none' }}
      >
        {positioned.map((t) => {
          const k = hexKey(t.hex);
          const draftIdx = draftIndexByKey.get(k);
          const drafted = draftIdx !== undefined;
          const carpenterIdx = carpenterIndexByKey.get(k);
          const isCarpenterTarget = carpenterIdx !== undefined;
          const isCarpenterEligible = eligibleCarpenter.has(k);
          const isDropTarget =
            interactive &&
            !!letterDrag &&
            t.state === 'active' &&
            !t.letter;
          const isDropHover =
            isDropTarget &&
            dropHover !== null &&
            hexEquals(dropHover, t.hex);
          const hideLetter = draggingFromKey === k;
          const interactiveTile =
            interactive &&
            ((t.state === 'storage' && !!t.letter) ||
              t.state === 'letter' ||
              t.state === 'capped' ||
              isDropTarget ||
              (t.state === 'inactive' && isCarpenterEligible));
          const tileSize =
            t.state === 'hive'
              ? HEX_SIZE * 1.05
              : t.state === 'storage'
                ? HEX_SIZE * 0.78
                : HEX_SIZE;
          return (
            <g key={k} transform={`translate(${t.pixel.x},${t.pixel.y})`}>
              <path
                d={hexPath(tileSize)}
                className="hex-tile"
                data-state={t.state}
                data-filled={t.state === 'storage' && !!t.letter}
                data-draft={drafted}
                data-draft-idx={draftIdx ?? undefined}
                data-carpenter-target={isCarpenterTarget}
                data-carpenter-eligible={isCarpenterEligible && !isCarpenterTarget}
                data-drop-target={isDropTarget}
                data-drop-hover={isDropHover}
                data-interactive={interactiveTile}
                onPointerDown={() => handlePointerDown(t.hex, t)}
                onPointerEnter={() => handlePointerEnter(t.hex, t)}
                onPointerLeave={() => handlePointerLeave(t.hex)}
              />
              {t.state === 'hive' && (
                <text className="hive-glyph" x={0} y={0}>
                  ⬢
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
              {isCarpenterTarget && (
                <g className="carpenter-badge">
                  <circle r={9} cx={HEX_SIZE * 0.55} cy={-HEX_SIZE * 0.55} />
                  <text x={HEX_SIZE * 0.55} y={-HEX_SIZE * 0.55}>
                    {(carpenterIdx ?? 0) + 1}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
