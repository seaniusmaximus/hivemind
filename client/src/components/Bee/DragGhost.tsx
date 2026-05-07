import { useEffect, useState } from 'react';
import { useGameStore } from '../../state/gameStore.js';

/**
 * Pointer-following ghost rendered while the player is drag-moving a letter
 * from a storage slot to an active tile. Renders as a fixed-position div above
 * the grid; updates on every `pointermove` so the letter feels like it's being
 * physically carried.
 */
export const DragGhost = () => {
  const drag = useGameStore((s) => s.letterDrag);
  const dropHover = useGameStore((s) => s.dropHover);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!drag) {
      setPos(null);
      return;
    }
    const onMove = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    document.addEventListener('pointermove', onMove);
    // Seed with current pointer position if available via the next move event;
    // until the user actually moves, the ghost won't render — that's fine.
    return () => document.removeEventListener('pointermove', onMove);
  }, [drag]);

  if (!drag || !pos) return null;

  return (
    <div
      className="drag-ghost"
      data-armed={dropHover !== null}
      style={{ left: pos.x, top: pos.y }}
      aria-hidden
    >
      {drag.letter}
    </div>
  );
};
