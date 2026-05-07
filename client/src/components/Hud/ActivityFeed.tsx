import { useGameStore } from '../../state/gameStore.js';

export const ActivityFeed = () => {
  const log = useGameStore((s) => s.world.log);
  const selfId = useGameStore((s) => s.world.self.id);

  if (log.length === 0) return null;

  return (
    <ul className="activity-feed" aria-label="recent activity">
      {log.slice(0, 5).map((entry) => (
        <li
          key={entry.id}
          data-mine={entry.ownerId === selfId}
          className="activity-entry"
        >
          {entry.text}
        </li>
      ))}
    </ul>
  );
};
