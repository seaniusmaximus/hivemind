import { useEffect, useRef } from 'react';
import { playIncomingQueenWarning } from '../../game/audio/sfx.js';
import { INCOMING_QUEEN_TOAST_MS, useGameStore, type ClientWorld } from '../../state/gameStore.js';

const incomingFlyingQueenIds = (world: ClientWorld): Set<string> =>
  new Set(
    world.opponents
      .flatMap((o) => o.bees)
      .filter(
        (b) =>
          b.kind === 'queen' &&
          b.state.kind === 'queen-flying' &&
          b.state.defenderPlayerId === world.self.id,
      )
      .map((b) => b.id),
  );

/**
 * When a rival dispatches a queen at us, their bee is `queen-flying` with
 * `defenderPlayerId` set to our id — show a warning on hive and flower panels.
 */
export const IncomingQueenWatcher = () => {
  const prevFlyingQueenIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    prevFlyingQueenIds.current = incomingFlyingQueenIds(useGameStore.getState().world);

    const unsub = useGameStore.subscribe((state) => {
      const ids = incomingFlyingQueenIds(state.world);
      const prev = prevFlyingQueenIds.current;
      const brandNew = [...ids].filter((id) => !prev.has(id));
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
