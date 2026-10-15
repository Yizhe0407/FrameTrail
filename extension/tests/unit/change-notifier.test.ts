import { describe, expect, it, vi } from 'vitest';
import { notifyProjectsChanged, subscribeProjectsChanged } from '@/lib/storage/change-notifier';

describe('project change notifier', () => {
  it('delivers a write notification to subscribers, and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectsChanged(listener);

    notifyProjectsChanged();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    unsubscribe();
    notifyProjectsChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
