import type { PanelIndex } from '../state/gameStore.js';

/** DOM `data-tutorial-target` values used for highlight rings. */
export type TutorialTarget =
  | 'hive-center'
  | 'honey-label'
  | 'flower-petal'
  | 'storage-ring'
  | 'hive-grid'
  | 'queen-spawn'
  | 'panel-arrow-right'
  | 'panel-arrow-left';

export type TutorialStepId =
  | '1a-hive'
  | '1b-flowers'
  | 'playing-collect-letter'
  | 'waiting-worker-return'
  | '2a-storage'
  | 'playing-place-bee-letters'
  | '3a-draft'
  | 'playing-spell-bee'
  | 'waiting-bee-cap'
  | '3b-pollen-bloom'
  | '3c-frontier-expand'
  | 'waiting-carpenter-expand'
  | '3d-reuse'
  | 'playing-spell-reuse'
  | 'waiting-bees-cap'
  | '3e-navigation'
  | 'waiting-queen-ready'
  | '4a-queen'
  | 'complete';

export interface TutorialStepConfig {
  readonly id: TutorialStepId;
  readonly panel: PanelIndex;
  readonly targets: readonly TutorialTarget[];
  readonly body: string;
  /** When true, the primary button reads "Resume play" and unpauses the simulation. */
  readonly sectionEnd: boolean;
}

export const TUTORIAL_STEPS: Record<
  Exclude<
    TutorialStepId,
    | 'playing-collect-letter'
    | 'waiting-worker-return'
    | 'playing-place-bee-letters'
    | 'playing-spell-bee'
    | 'waiting-bee-cap'
    | 'waiting-carpenter-expand'
    | 'playing-spell-reuse'
    | 'waiting-bees-cap'
    | 'waiting-queen-ready'
    | 'complete'
  >,
  TutorialStepConfig
> = {
  '1a-hive': {
    id: '1a-hive',
    panel: 0,
    targets: ['hive-center', 'honey-label'],
    body:
      'This is your hive. It is the lifeblood of your colony. Your honey supply is displayed here. Honey is used to fuel bees. Bees collect letters, expand your colony, and assault your rival\'s hive.',
    sectionEnd: false,
  },
  '1b-flowers': {
    id: '1b-flowers',
    panel: 1,
    targets: ['flower-petal'],
    body:
      'This is the flower field. Worker bees can be dispatched to the flowers to collect letters for your hive. Press and hold on a letter to dispatch a worker. Flowers slowly wither away and your rival shares this resource field. Bee fast.',
    sectionEnd: true,
  },
  '2a-storage': {
    id: '2a-storage',
    panel: 0,
    targets: ['storage-ring'],
    body:
      'Your workers will store letters in the space around your hive. Use these letters to spell the word "bee" in the available colony space by dragging the letters into empty solid blue hexes.',
    sectionEnd: true,
  },
  '3a-draft': {
    id: '3a-draft',
    panel: 0,
    targets: ['hive-grid'],
    body:
      'Drag and swipe across the letters you placed to spell a word. Your drone will cap the used letters, locking them in place and scoring the word. Each letter used has a pollen value which the drone will convert to honey. Capping a word will also trigger a carpenter bee to expand your colony.',
    sectionEnd: true,
  },
  '3b-pollen-bloom': {
    id: '3b-pollen-bloom',
    panel: 0,
    targets: ['hive-grid'],
    body:
      'Bee-related words trigger a temporary "pollen bloom" boosting stored honey, greatly increasing colony growth, and spawning new flowers.',
    sectionEnd: false,
  },
  '3c-frontier-expand': {
    id: '3c-frontier-expand',
    panel: 0,
    targets: ['hive-grid'],
    body:
      'Frontier hexes are highlighted in a dashed cyan outline. Carpenter bees will expand your colony automatically when you cap a word. The longer the word, the more hexes they will expand. You can also manually press and hold on a frontier hex to dispatch a carpenter bee.',
    sectionEnd: false,
  },
  '3d-reuse': {
    id: '3d-reuse',
    panel: 0,
    targets: ['storage-ring'],
    body:
      'Capped letters can be reused to spell new words. Add the S tile to your word, then drag and swipe to submit the newly formed word. Reused letters are "fortified" by the drone, making them more protected from the enemy Queens.',
    sectionEnd: true,
  },
  '3e-navigation': {
    id: '3e-navigation',
    panel: 0,
    targets: ['panel-arrow-right', 'panel-arrow-left'],
    body:
      'Navigate between your Hive and the Flower Field by swiping or using the arrow buttons on the left and right of the screen.',
    sectionEnd: true,
  },
  '4a-queen': {
    id: '4a-queen',
    panel: 0,
    targets: ['queen-spawn'],
    body:
      'Once you have accumulated enough honey for the colony, you may spawn a Queen to assault the rival hive. Click the Spawn Queen button then select your angle of attack on the rival hive. Queens slowly approach the rival hive and assault their colony from your chosen direction. If a Queen breaches the colony storage that player\'s colony collapses and they lose the game. Bee ready.',
    sectionEnd: true,
  },
};

export const isTutorialPlayingStep = (step: TutorialStepId | null): boolean =>
  step === 'playing-collect-letter' ||
  step === 'waiting-worker-return' ||
  step === 'playing-place-bee-letters' ||
  step === 'playing-spell-bee' ||
  step === 'waiting-bee-cap' ||
  step === 'waiting-carpenter-expand' ||
  step === 'playing-spell-reuse' ||
  step === 'waiting-bees-cap' ||
  step === 'waiting-queen-ready';

export const tutorialStepConfig = (
  step: TutorialStepId | null,
): TutorialStepConfig | null => {
  if (!step || step === 'complete' || isTutorialPlayingStep(step)) return null;
  return TUTORIAL_STEPS[step as keyof typeof TUTORIAL_STEPS];
};
