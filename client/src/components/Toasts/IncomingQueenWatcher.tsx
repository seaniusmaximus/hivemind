import { useEffect, useRef } from 'react';
import type { Bee } from '@hivemind/shared';
import { playIncomingQueenWarning } from '../../game/audio/sfx.js';
import { INCOMING_QUEEN_TOAST_MS, useGameStore } from '../../state/gameStore.js';

const flyingQueenIds = (bees: readonly Bee[]): Set<string> =>
  new Set(
    bees
      .filter((b) => b.kind === 'queen' && b.state.kind === 'queen-flying')
      .map((b) => b.id),
  );

/**
 * When the opponent dispatches a queen, their bee appears as `queen-flying` on
 * **our** `world.opponent` slice — show a prominent warning anchored on both the
 * hive and the flower field so it's visible whichever panel the player has open.
 */
export const IncomingQueenWatcher = () => {
  const prevFlyingQueenIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    prevFlyingQueenIds.current = flyingQueenIds(useGameStore.getState().world.opponent.bees);

    const unsub = useGameStore.subscribe((state) => {
      const ids = flyingQueenIds(state.world.opponent.bees);
      const prev = prevFlyingQueenIds.current;
      const brandNew = [...ids].filter((id) => !prev.has(id));
      // Commit ids *before* pushToast: toast updates the store synchronously and
      // re-enters this subscriber — if prev isn't updated first, every pass
      // still looks like a "new" queen (sound + toast cascade).
      prevFlyingQueenIds.current = ids;
      const toastPayload = {
        text: '!! INCOMING QUEEN !!',
        variant: 'alert' as const,
        lifetimeMs: INCOMING_QUEEN_TOAST_MS,
      };
      if (brandNew.length === 0) return;
      playIncomingQueenWarning(INCOMING_QUEEN_TOAST_MS);
      const push = useGameStore.getState().pushToast;
      for (const _ of brandNew) {
        push({ ...toastPayload, panel: 'self-hive', hex: { q: 0, r: 0 } });
        push({ ...toastPayload, panel: 'flowers', hex: { q: 0, r: 0 } });
      }
    });

    return unsub;
  }, []);

  return null;
};
