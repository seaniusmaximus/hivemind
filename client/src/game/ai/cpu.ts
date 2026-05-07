import type { WorldSnapshot } from '@hivemind/shared';

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * Stub for the CPU opponent. Future iterations will:
 * - read the snapshot to decide which flowers to harvest
 * - dispatch worker / carpenter / drone bees on a delay matching `Difficulty`
 * - use a trie of common 3-7 letter words to plan placements + chains
 */
export interface CpuOpponent {
  step: (snapshot: WorldSnapshot, dt: number) => void;
}

export const createCpuOpponent = (difficulty: Difficulty): CpuOpponent => {
  let cooldown = 0;
  const baseCooldown = difficulty === 'easy' ? 4 : difficulty === 'medium' ? 2 : 1;
  return {
    step: (_snapshot, dt) => {
      cooldown -= dt;
      if (cooldown <= 0) {
        cooldown = baseCooldown;
      }
    },
  };
};
