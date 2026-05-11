import { useEffect } from 'react';
import {
  hasWordCapHoneyLogEntrySeen,
  markWordCapHoneyLogEntrySeen,
} from '../../game/wordCapHoneyToastSeen.js';
import { useGameStore } from '../../state/gameStore.js';

const HONEY_BONUS_RE = /\+(\d+)\s*🜨/;

/**
 * When the engine logs a word-cap honey line for the local player, show a short toast.
 * Log entries are newest-first; {@link resetWordCapHoneyToastSeen} seeds known ids.
 */
export const WordCapHoneyWatcher = () => {
  useEffect(() => {
    return useGameStore.subscribe((s) => {
      const selfId = s.world.self.id;
      const pushToast = useGameStore.getState().pushToast;
      for (const e of s.world.log) {
        if (hasWordCapHoneyLogEntrySeen(e.id)) break;
        markWordCapHoneyLogEntrySeen(e.id);
        if (e.ownerId !== selfId) continue;
        const bonusMatch = e.text.match(HONEY_BONUS_RE);
        if (!bonusMatch) continue;
        const n = bonusMatch[1]!;
        const reuse = e.text.includes('reuse');
        pushToast({
          text: reuse ? `Word bonus +${n} 🜨 (reuse)` : `Word bonus +${n} 🜨`,
          panel: 'self-hive',
          hex: { q: 0, r: 0 },
          variant: 'info',
          lifetimeMs: 2400,
        });
      }
    });
  }, []);

  return null;
};
