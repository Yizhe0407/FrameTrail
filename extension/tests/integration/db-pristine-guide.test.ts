import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageArea = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async (key: string) => (values.has(key) ? { [key]: values.get(key) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: { storage: { local: localStorageArea, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } },
}));

import {
  closeDatabase,
  createGuide,
  discardPristineGuide,
  getGuide,
  isPristineGuide,
  updateGuide,
  addStep,
  type Step,
} from '@/lib/storage/db';
import { ACTIVE_GUIDE_ID_KEY, getActiveGuideId, setActiveGuideId } from '@/lib/storage/storage';

afterAll(closeDatabase);

beforeEach(() => {
  localStorageArea.values.clear();
});

function makeStep(sessionId: string, overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId,
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/jpeg' }),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('isPristineGuide', () => {
  it('recognises the exact empty shell createGuide leaves behind', async () => {
    const guide = await createGuide();
    expect(isPristineGuide(guide)).toBe(true);
  });

  it('stops matching once the user names, describes, or tags the guide', async () => {
    const named = await createGuide({ title: '我的教學' });
    const described = await createGuide({ description: '說明' });
    const tagged = await createGuide({ tags: ['入門'] });

    expect(isPristineGuide(named)).toBe(false);
    expect(isPristineGuide(described)).toBe(false);
    expect(isPristineGuide(tagged)).toBe(false);
  });

  it('stops matching once anything was recorded into the guide', async () => {
    const guide = await createGuide();
    await addStep(makeStep(guide.id));

    expect(isPristineGuide((await getGuide(guide.id))!)).toBe(false);
  });
});

describe('discardPristineGuide', () => {
  it('deletes a pristine guide and compare-and-clears the matching selection', async () => {
    const guide = await createGuide();
    await setActiveGuideId(guide.id);

    await expect(discardPristineGuide(guide.id)).resolves.toBe(true);

    await expect(getGuide(guide.id)).resolves.toBeUndefined();
    await expect(getActiveGuideId()).resolves.toBeNull();
  });

  it('leaves a different selection untouched', async () => {
    const guide = await createGuide();
    await setActiveGuideId('guide-other');

    await expect(discardPristineGuide(guide.id)).resolves.toBe(true);

    expect(localStorageArea.values.get(ACTIVE_GUIDE_ID_KEY)).toBe('guide-other');
  });

  it('never deletes a guide the user meanwhile touched', async () => {
    const guide = await createGuide();
    await updateGuide(guide.id, { title: '我的教學' });
    await setActiveGuideId(guide.id);

    await expect(discardPristineGuide(guide.id)).resolves.toBe(false);

    await expect(getGuide(guide.id)).resolves.toMatchObject({ id: guide.id, title: '我的教學' });
    await expect(getActiveGuideId()).resolves.toBe(guide.id);
  });

  it('treats an already-deleted guide as a no-op', async () => {
    await expect(discardPristineGuide('guide-gone')).resolves.toBe(false);
  });
});
