import { BEE_STATS, type Letter } from '@hivemind/shared';
import { useGameStore } from '../../state/gameStore.js';
import {
  CARPENTER_QUEUE_CAP,
  QUEUE_CAP,
  petalAt,
} from '../../game/engine/state.js';

export const QueuePanel = () => {
  const queue = useGameStore((s) => s.world.self.letterQueue);
  const carpenterQueue = useGameStore((s) => s.world.self.carpenterQueue);
  const patches = useGameStore((s) => s.world.patches);
  const honey = useGameStore((s) => Math.floor(s.world.self.honey));
  const lastError = useGameStore((s) => s.lastError);
  const spawnWorker = useGameStore((s) => s.spawnWorker);
  const spawnCarpenter = useGameStore((s) => s.spawnCarpenter);
  const toggleQueue = useGameStore((s) => s.toggleLetterQueue);
  const toggleCarpenter = useGameStore((s) => s.toggleCarpenterTarget);

  const letters: { letter: Letter; idx: number }[] = queue.map((h, idx) => {
    const found = petalAt(patches, h);
    return { letter: (found?.petal.letter ?? '?') as Letter, idx };
  });

  const workerCost = BEE_STATS.worker.honeyCost;
  const carpenterCost = BEE_STATS.carpenter.honeyCost;

  return (
    <div className="queue-panel">
      <section>
        <h3 className="queue-title">
          QUEUE <span className="queue-count">{queue.length}/{QUEUE_CAP}</span>
        </h3>
        {letters.length === 0 ? (
          <p className="queue-empty">tap flowers in the field to queue letters</p>
        ) : (
          <ol className="queue-list">
            {letters.map(({ letter, idx }) => (
              <li key={idx}>
                <button
                  type="button"
                  className="queue-chip"
                  onClick={() => toggleQueue(queue[idx]!)}
                  aria-label={`Remove ${letter} from queue`}
                >
                  <span className="queue-chip-num">{idx + 1}</span>
                  <span className="queue-chip-letter">{letter}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          className="hud-action send-worker"
          onClick={() => spawnWorker()}
          disabled={queue.length === 0 || honey < workerCost}
          aria-label="Send worker"
        >
          SEND WORKER
          <span className="hud-action-cost">{workerCost}🜨</span>
        </button>
      </section>

      <section className="carpenter-section">
        <h3 className="queue-title">
          BUILD <span className="queue-count">{carpenterQueue.length}/{CARPENTER_QUEUE_CAP}</span>
        </h3>
        {carpenterQueue.length === 0 ? (
          <p className="queue-empty">tap an outer tile next to your hive to grow</p>
        ) : (
          <ol className="queue-list">
            {carpenterQueue.map((h, idx) => (
              <li key={idx}>
                <button
                  type="button"
                  className="queue-chip carpenter-chip"
                  onClick={() => toggleCarpenter(h)}
                  aria-label="Remove tile from carpenter queue"
                >
                  <span className="queue-chip-num">{idx + 1}</span>
                  <span className="queue-chip-letter" aria-hidden>
                    +
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          className="hud-action send-carpenter"
          onClick={() => spawnCarpenter()}
          disabled={carpenterQueue.length === 0 || honey < carpenterCost}
          aria-label="Send carpenter"
        >
          SEND CARPENTER
          <span className="hud-action-cost">{carpenterCost}🜨</span>
        </button>
      </section>

      {lastError ? <div className="queue-error">{lastError}</div> : null}
    </div>
  );
};
