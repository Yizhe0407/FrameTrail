// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCommittedDescriptionDraft,
  clearMatchingCommittedDescriptionDrafts,
  DESCRIPTION_DRAFT_JOURNAL_LIMITS,
  discardDescriptionDraft,
  readDescriptionDrafts,
  writeDescriptionDraft,
} from '@/lib/editor-draft-journal';

const step = {
  id: 'step-1',
  sessionId: 'guide-1',
  description: '已儲存',
};

class StorageProxy implements Storage {
  setCalls = 0;
  failSetCall: number | null = null;

  constructor(private readonly target: Storage) {}

  get length() { return this.target.length; }
  clear() { this.target.clear(); }
  getItem(key: string) { return this.target.getItem(key); }
  key(index: number) { return this.target.key(index); }
  removeItem(key: string) { this.target.removeItem(key); }
  setItem(key: string, value: string) {
    this.setCalls += 1;
    if (this.setCalls === this.failSetCall) throw new DOMException('quota failure', 'QuotaExceededError');
    this.target.setItem(key, value);
  }
}

function metadataKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key?.includes(':v2:meta:') ?? false);
}

beforeEach(() => localStorage.clear());

describe('editor description draft journal', () => {
  it('keeps two writers for the same step isolated and sorts newest first', () => {
    expect(writeDescriptionDraft(step, '分頁 A', 'writer-a', localStorage, 1_000)).toBe(true);
    expect(writeDescriptionDraft(step, '分頁 B', 'writer-b', localStorage, 2_000)).toBe(true);

    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 2_001)).toEqual([
      {
        writerId: 'writer-b',
        description: '分頁 B',
        updatedAt: 2_000,
        belongsToCurrentWriter: false,
        conflictsWithPersistedValue: false,
      },
      {
        writerId: 'writer-a',
        description: '分頁 A',
        updatedAt: 1_000,
        belongsToCurrentWriter: true,
        conflictsWithPersistedValue: false,
      },
    ]);
  });

  it('clears only the completed writer and only when its exact draft committed', () => {
    writeDescriptionDraft(step, 'A 第一版', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, 'B 草稿', 'writer-b', localStorage, 1_001);
    writeDescriptionDraft(step, 'A 最後版', 'writer-a', localStorage, 1_002);

    clearCommittedDescriptionDraft(step, 'writer-a', 'A 第一版', localStorage);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_003).map((draft) => draft.description)).toEqual([
      'A 最後版',
      'B 草稿',
    ]);

    clearCommittedDescriptionDraft(step, 'writer-a', 'A 最後版', localStorage);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_004).map((draft) => draft.description)).toEqual([
      'B 草稿',
    ]);
  });

  it('marks a conflict by exact base value rather than a lossy hash', () => {
    writeDescriptionDraft(step, '本機草稿', 'writer-a', localStorage, 1_000);
    expect(
      readDescriptionDrafts({ ...step, description: '其他分頁的新內容' }, 'writer-a', localStorage, 1_001)[0],
    ).toMatchObject({ description: '本機草稿', conflictsWithPersistedValue: true });
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_001)[0]).toMatchObject({
      conflictsWithPersistedValue: false,
    });
  });

  it('updates a 100,000-character draft with bounded synchronous writes', () => {
    const storage = new StorageProxy(localStorage);
    const first = 'x'.repeat(99_999);
    expect(writeDescriptionDraft({ ...step, description: '' }, first, 'writer-a', storage, 1_000)).toBe(true);
    storage.setCalls = 0;

    expect(writeDescriptionDraft({ ...step, description: '' }, `${first}y`, 'writer-a', storage, 1_001)).toBe(true);
    expect(storage.setCalls).toBeLessThanOrEqual(2); // one changed chunk plus metadata
    expect(readDescriptionDrafts({ ...step, description: '' }, 'writer-a', storage, 1_002)[0]?.description).toBe(`${first}y`);
  });

  it.each([
    ['chunk write', 1],
    ['metadata commit', 2],
  ])('retains the previous atomic record when a %s fails', (_label, failSetCall) => {
    writeDescriptionDraft(step, '完整舊草稿', 'writer-a', localStorage, 1_000);
    const storage = new StorageProxy(localStorage);
    storage.failSetCall = failSetCall;

    expect(writeDescriptionDraft(step, '完整舊草稿加一字', 'writer-a', storage, 1_001)).toBe(false);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_002)[0]?.description).toBe('完整舊草稿');
  });

  it('fails closed and removes metadata when a referenced chunk is missing', () => {
    writeDescriptionDraft(step, '需要完整分塊', 'writer-a', localStorage, 1_000);
    const key = metadataKeys()[0];
    const metadata = JSON.parse(localStorage.getItem(key)!) as { descriptionChunks: string[] };
    localStorage.removeItem(metadata.descriptionChunks[0]);

    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_001)).toEqual([]);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('prunes only old orphan chunks, preserving a fresh in-progress cross-tab write', () => {
    const old = 'frametrail:editor-description-draft:v2:chunk:guide:step:writer:description:1000-rev:0';
    const fresh = 'frametrail:editor-description-draft:v2:chunk:guide:step:writer:description:999999-rev:0';
    localStorage.setItem(old, 'old');
    localStorage.setItem(fresh, 'fresh');

    readDescriptionDrafts(step, 'writer-a', localStorage, 1_000_000);
    expect(localStorage.getItem(old)).toBeNull();
    expect(localStorage.getItem(fresh)).toBe('fresh');
  });

  it('reclaims stale orphan chunks before allocating when they are blocking quota', () => {
    const orphan = 'frametrail:editor-description-draft:v2:chunk:guide:step:writer:description:1000-rev:0';
    localStorage.setItem(orphan, 'stale quota consumer');
    const storage: Storage = {
      get length() { return localStorage.length; },
      clear: () => localStorage.clear(),
      getItem: (key) => localStorage.getItem(key),
      key: (index) => localStorage.key(index),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        if (localStorage.getItem(orphan) !== null) {
          throw new DOMException('quota failure', 'QuotaExceededError');
        }
        localStorage.setItem(key, value);
      },
    };

    expect(writeDescriptionDraft(step, '可恢復寫入', 'writer-a', storage, 1_000_000)).toBe(true);
    expect(localStorage.getItem(orphan)).toBeNull();
    expect(readDescriptionDrafts(step, 'writer-a', storage, 1_000_001)[0]?.description).toBe('可恢復寫入');
  });

  it('recovers and selectively clears a legacy v1 record', () => {
    localStorage.setItem(
      'frametrail:editor-description-draft:v1:guide-1:step-1',
      JSON.stringify({
        version: 1,
        stepId: 'step-1',
        sessionId: 'guide-1',
        baseDescription: '已儲存',
        description: '舊版草稿',
        updatedAt: 1_000,
      }),
    );

    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_001)[0]).toMatchObject({
      writerId: 'legacy-v1',
      description: '舊版草稿',
      belongsToCurrentWriter: false,
    });
    expect(discardDescriptionDraft(step, 'legacy-v1', localStorage)).toBe(true);
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 1_002)).toEqual([]);
  });

  it('clears all and only candidates matching the authoritative commit', () => {
    writeDescriptionDraft(step, '相同內容', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, '相同內容', 'writer-b', localStorage, 1_001);
    writeDescriptionDraft(step, '替代內容', 'writer-c', localStorage, 1_002);

    clearMatchingCommittedDescriptionDrafts(step, '相同內容', localStorage);
    expect(readDescriptionDrafts({ ...step, description: '相同內容' }, 'writer-a', localStorage, 1_003)).toEqual([
      expect.objectContaining({ writerId: 'writer-c', description: '替代內容' }),
    ]);
  });

  it('removes expired and malformed records instead of restoring untrusted data', () => {
    writeDescriptionDraft(step, '過期草稿', 'writer-a', localStorage, 1_000);
    expect(
      readDescriptionDrafts(
        step,
        'writer-a',
        localStorage,
        1_000 + DESCRIPTION_DRAFT_JOURNAL_LIMITS.maxAgeMs + 1,
      ),
    ).toEqual([]);
    expect(localStorage.length).toBe(0);

    localStorage.setItem('frametrail:editor-description-draft:v1:guide-1:step-1', '{broken');
    expect(readDescriptionDrafts(step, 'writer-a', localStorage, 2_000)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('counts legacy and v2 records at the global bound without evicting recoverable drafts', () => {
    localStorage.setItem(
      'frametrail:editor-description-draft:v1:legacy-guide:legacy-step',
      JSON.stringify({
        version: 1,
        stepId: 'legacy-step',
        sessionId: 'legacy-guide',
        baseDescription: '',
        description: 'legacy',
        updatedAt: 1_000,
      }),
    );
    for (let index = 0; index < DESCRIPTION_DRAFT_JOURNAL_LIMITS.maxRecords - 1; index += 1) {
      expect(
        writeDescriptionDraft(
          { id: `step-${index}`, sessionId: 'guide', description: '' },
          `draft-${index}`,
          `writer-${index}`,
          localStorage,
          1_001 + index,
        ),
      ).toBe(true);
    }
    expect(
      writeDescriptionDraft(
        { id: 'overflow', sessionId: 'guide', description: '' },
        'must not evict another draft',
        'overflow-writer',
        localStorage,
        2_000,
      ),
    ).toBe(false);
  });

  it('never lets malicious metadata delete chunks owned by another record', () => {
    writeDescriptionDraft(step, '安全草稿 A', 'writer-a', localStorage, 1_000);
    writeDescriptionDraft(step, '安全草稿 B', 'writer-b', localStorage, 1_001);
    const [keyA, keyB] = metadataKeys().sort();
    const metadataA = JSON.parse(localStorage.getItem(keyA)!) as { descriptionChunks: string[] };
    const metadataB = JSON.parse(localStorage.getItem(keyB)!) as { descriptionChunks: string[] };
    metadataA.descriptionChunks = [...metadataB.descriptionChunks];
    localStorage.setItem(keyA, JSON.stringify(metadataA));

    readDescriptionDrafts(step, 'writer-a', localStorage, 1_002);
    expect(readDescriptionDrafts(step, 'writer-b', localStorage, 1_003)).toContainEqual(
      expect.objectContaining({ writerId: 'writer-b', description: '安全草稿 B' }),
    );
  });

  it('does not rewrite unchanged chunks when the clock rolls backward', () => {
    const storage = new StorageProxy(localStorage);
    writeDescriptionDraft(step, '草稿', 'writer-a', storage, 2_000);
    storage.setCalls = 0;
    expect(writeDescriptionDraft(step, '草稿更新', 'writer-a', storage, 1_500)).toBe(true);
    expect(storage.setCalls).toBeGreaterThan(0);
    expect(readDescriptionDrafts(step, 'writer-a', storage, 1_501)[0]?.description).toBe('草稿更新');
  });
});
