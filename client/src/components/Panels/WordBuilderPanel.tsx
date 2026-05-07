import { useEffect, useState } from 'react';
import { BEE_STATS, hexEquals, type Hex, type Letter } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import { subscribeDict, wordStatus, type WordStatus } from '../../game/dictionary.js';

const STATUS_LABEL: Record<WordStatus, string> = {
  valid: '✓',
  invalid: '✗',
  pending: '…',
  unknown: '?',
};

const draftToWord = (
  path: readonly Hex[],
  tiles: readonly { hex: Hex; letter: Letter | null }[],
): string =>
  path
    .map((h) => tiles.find((t) => hexEquals(t.hex, h))?.letter ?? '')
    .join('')
    .toUpperCase();

export const WordBuilderPanel = () => {
  const drafts = useGameStore((s) => s.wordDrafts);
  const tiles = useGameStore((s) => s.world.self.tiles);
  const honey = useGameStore((s) => Math.floor(s.world.self.honey));
  const submitting = useGameStore((s) => s.submitting);
  const submitDraft = useGameStore((s) => s.submitDraft);
  const clearDraft = useGameStore((s) => s.clearDraft);
  const removeDraft = useGameStore((s) => s.removeDraft);

  // Re-render whenever the dictionary cache updates so the status badges
  // transition from … to ✓/✗ without needing a manual nudge.
  const [, force] = useState(0);
  useEffect(() => subscribeDict(() => force((n) => (n + 1) % 1024)), []);

  const words = drafts.map((path) => draftToWord(path, tiles));
  const statuses = words.map((w) => wordStatus(w));
  const cost = BEE_STATS.drone.honeyCost;
  const cap = BEE_STATS.drone.capacity;
  const hasAnyValid = statuses.some((s) => s === 'valid' || s === 'pending' || s === 'unknown');
  const hasShared = drafts.some((p1, i) =>
    drafts.some((p2, j) => i < j && p1.some((a) => p2.some((b) => hexEquals(a, b)))),
  );

  return (
    <div className="word-panel">
      <h3 className="word-title">
        WORDS <span className="queue-count">{drafts.length}/{cap}</span>
      </h3>
      {drafts.length === 0 ? (
        <p className="queue-empty">drag across letter or capped tiles to draft a word</p>
      ) : (
        <ol className="word-list">
          {words.map((word, idx) => {
            const status = statuses[idx]!;
            return (
              <li key={idx} className="word-row" data-status={status}>
                <span className="word-text">{word || '–'}</span>
                <span className="word-status" title={status} aria-label={`status: ${status}`}>
                  {STATUS_LABEL[status]}
                </span>
                <button
                  type="button"
                  className="word-remove ghost"
                  onClick={() => removeDraft(idx)}
                  aria-label={`Remove ${word}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {hasShared && drafts.length >= 2 ? (
        <div className="chain-hint" aria-live="polite">
          chain shares a tile · ×1.5 bonus
        </div>
      ) : null}
      <div className="word-actions">
        <button
          type="button"
          onClick={() => {
            void submitDraft();
          }}
          disabled={!hasAnyValid || honey < cost || submitting}
          aria-label="Submit words"
        >
          {submitting ? 'CHECKING…' : 'SUBMIT'}
          <span className="hud-action-cost">{cost}🜨</span>
        </button>
        <button
          type="button"
          onClick={clearDraft}
          disabled={drafts.length === 0}
          className="ghost"
          aria-label="Clear drafts"
        >
          CLEAR
        </button>
      </div>
    </div>
  );
};
