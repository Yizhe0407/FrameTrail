import { describe, expect, it } from 'vitest';
import {
  GuideStructureIntegrityError,
  buildCompleteStepEntries,
  type Step,
} from '@/lib/storage/models';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId: 'guide',
    order: 0,
    screenshotBlob: new Blob(['pixels'], { type: 'image/png' }),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
    ...overrides,
  };
}

function makeGroup(order = 0): [Step, Step, Step] {
  const groupId = crypto.randomUUID();
  return [
    makeStep({ id: groupId, groupId, order, bounds: null }),
    makeStep({ groupId, order: order + 1, screenshotBlob: undefined }),
    makeStep({ groupId, order: order + 2, screenshotBlob: undefined }),
  ];
}

describe('buildCompleteStepEntries', () => {
  it('builds a complete contiguous snapshot group', () => {
    const [anchor, first, second] = makeGroup();

    const entries = buildCompleteStepEntries([second, anchor, first], 'guide');

    expect(entries).toEqual([{ kind: 'group', anchor, annotations: [first, second] }]);
  });

  it.each(['ordinary step', 'another snapshot group'])('rejects a snapshot group split by %s', (separator) => {
    const [anchor, first, second] = makeGroup();
    const middle = separator === 'ordinary step'
      ? makeStep({ order: 2 })
      : makeGroup(2)[0];
    second.order = 3;

    expect(() => buildCompleteStepEntries([anchor, first, middle, second], 'guide'))
      .toThrow(GuideStructureIntegrityError);
  });
});
