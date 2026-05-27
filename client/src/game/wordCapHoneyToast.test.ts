import type { ActivityEntry } from '@hivemind/shared';
import { resetWordCapHoneyToastSeen } from './wordCapHoneyToastSeen.js';
import { drainWordCapHoneyToasts } from './wordCapHoneyToast.js';

const entry = (id: string, text: string, ownerId = 'self'): ActivityEntry => ({
  id,
  t: 0,
  ownerId,
  text,
});

describe('drainWordCapHoneyToasts', () => {
  beforeEach(() => resetWordCapHoneyToastSeen([]));

  it('shows pollen bloom toast for new bee-word cap lines', () => {
    const hive: string[] = [];
    const field: string[] = [];
    drainWordCapHoneyToasts(
      [],
      [entry('a', 'QUEEN +5 🜨 pollen bloom!')],
      'self',
      (p) => hive.push(p.text),
      () => field.push('pollen bloom'),
    );
    expect(hive).toEqual(['Pollen bloom! +5 🜨']);
    expect(field).toEqual(['pollen bloom']);
  });

  it('shows word bonus for normal caps', () => {
    const pushed: string[] = [];
    drainWordCapHoneyToasts([], [entry('b', 'CAT +3 🜨')], 'self', (p) => pushed.push(p.text));
    expect(pushed).toEqual(['Word bonus +3 🜨']);
  });

  it('ignores opponent lines and already-known ids', () => {
    const prev = [entry('old', 'HIVE +1 🜨', 'opponent')];
    const hive: string[] = [];
    const field: string[] = [];
    drainWordCapHoneyToasts(
      prev,
      [entry('new', 'QUEEN +5 🜨 pollen bloom!', 'self'), ...prev],
      'self',
      (p) => hive.push(p.text),
      () => field.push('pollen bloom'),
    );
    expect(hive).toEqual(['Pollen bloom! +5 🜨']);
    expect(field).toEqual(['pollen bloom']);
  });
});
