import type { ActivityEntry } from '@hivemind/shared';
import {
  hasWordCapHoneyLogEntrySeen,
  markWordCapHoneyLogEntrySeen,
} from './wordCapHoneyToastSeen.js';

const HONEY_BONUS_RE = /\+(\d+)\s*🜨/;
const POLLEN_BLOOM_RE = /pollen bloom/i;

export interface WordCapToastPayload {
  readonly text: string;
  readonly variant: 'info' | 'alert';
  readonly lifetimeMs: number;
}

/**
 * Show toasts for new activity-log lines at the head of the feed (newest-first).
 * Compares `nextLog` to `prevLog` so we only react to entries that just appeared.
 */
export const drainWordCapHoneyToasts = (
  prevLog: readonly ActivityEntry[],
  nextLog: readonly ActivityEntry[],
  selfId: string,
  push: (payload: WordCapToastPayload) => void,
): void => {
  const prevIds = new Set(prevLog.map((e) => e.id));
  for (const e of nextLog) {
    if (prevIds.has(e.id)) break;
    if (hasWordCapHoneyLogEntrySeen(e.id)) continue;
    markWordCapHoneyLogEntrySeen(e.id);
    if (e.ownerId !== selfId) continue;

    const pollen = POLLEN_BLOOM_RE.test(e.text);
    const bonusMatch = e.text.match(HONEY_BONUS_RE);
    if (!pollen && !bonusMatch) continue;

    const n = bonusMatch?.[1];
    if (pollen) {
      push({
        text: n ? `Pollen bloom! +${n} 🜨` : 'Pollen bloom!',
        variant: 'alert',
        lifetimeMs: 2800,
      });
      continue;
    }

    const reuse = e.text.includes('reuse');
    push({
      text: reuse ? `Word bonus +${n} 🜨 (reuse)` : `Word bonus +${n} 🜨`,
      variant: 'info',
      lifetimeMs: 2400,
    });
  }
};
