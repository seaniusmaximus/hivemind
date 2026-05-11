/** Dedupe word-cap honey toasts vs activity log replays / snapshot reloads. */

const seen = new Set<string>();

/** Replace the set and mark every id as already handled (no toast). */
export const resetWordCapHoneyToastSeen = (markIds: readonly string[]): void => {
  seen.clear();
  for (const id of markIds) seen.add(id);
};

export const hasWordCapHoneyLogEntrySeen = (id: string): boolean => seen.has(id);

export const markWordCapHoneyLogEntrySeen = (id: string): void => {
  seen.add(id);
};
