// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshotTargetIdentity } from '@/lib/capture/selector/snapshot-identity';
import { resetSelectorDom } from '../setup/selector-dom';

afterEach(resetSelectorDom);
describe('buildSnapshotTargetIdentity', () => {
  it('keeps the same identity when a framework remounts the same logical control', () => {
    const container = document.createElement('div');
    container.id = 'toolbar';
    const first = document.createElement('button');
    container.append(first);
    document.body.append(container);
    const identity = buildSnapshotTargetIdentity(first);

    const replacement = document.createElement('button');
    first.replaceWith(replacement);

    expect(buildSnapshotTargetIdentity(replacement)).toBe(identity);
  });
});
