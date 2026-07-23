import { PERSISTED_STEP_LIMITS } from './persistence-limits';

const METADATA_PREFIX = 'frametrail:editor-description-draft:v2:meta:';
const CHUNK_PREFIX = 'frametrail:editor-description-draft:v2:chunk:';
const LEGACY_PREFIX = 'frametrail:editor-description-draft:v1:';
const WRITER_SESSION_KEY = 'frametrail:editor-description-draft:writer:v1';
const JOURNAL_VERSION = 2;
const CHUNK_CODE_UNITS = 4_096;
const MAX_DRAFT_RECORDS = 32;
const MAX_TOTAL_DRAFT_CODE_UNITS = 2_000_000;
const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const ORPHAN_GRACE_MS = 5 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;
const LEGACY_WRITER_ID = 'legacy-v1';

interface DraftStepIdentity {
  id: string;
  sessionId: string;
  description: string;
}

interface PersistedDescriptionDraftMetadata {
  version: typeof JOURNAL_VERSION;
  writerId: string;
  stepId: string;
  sessionId: string;
  baseLength: number;
  descriptionLength: number;
  baseChunks: string[];
  descriptionChunks: string[];
  updatedAt: number;
}

interface LegacyDescriptionDraft {
  version: 1;
  stepId: string;
  sessionId: string;
  baseDescription: string;
  description: string;
  updatedAt: number;
}

export interface RestoredDescriptionDraft {
  writerId: string;
  description: string;
  updatedAt: number;
  belongsToCurrentWriter: boolean;
  /** True when IndexedDB changed after this draft was written. */
  conflictsWithPersistedValue: boolean;
}

let pageWriterId: string | null = null;
let fallbackSequence = 0;

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PERSISTED_STEP_LIMITS.maxIdLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function newUniqueId(prefix: string): string {
  try {
    return crypto.randomUUID();
  } catch {
    fallbackSequence += 1;
    return `${prefix}-${Date.now()}-${fallbackSequence}-${Math.random().toString(36).slice(2)}`;
  }
}

function isReloadNavigation(): boolean {
  try {
    return performance.getEntriesByType('navigation').some(
      (entry) => (entry as PerformanceNavigationTiming).type === 'reload',
    );
  } catch {
    return false;
  }
}

/** A writer is stable across component remounts and a same-tab reload, but a
 * newly opened/duplicated tab rotates a cloned sessionStorage value. */
export function getDescriptionDraftWriterId(): string {
  if (pageWriterId) return pageWriterId;
  try {
    const stored = sessionStorage.getItem(WRITER_SESSION_KEY);
    if (stored && isValidIdentifier(stored) && isReloadNavigation()) {
      pageWriterId = stored;
      return pageWriterId;
    }
    pageWriterId = newUniqueId('writer');
    sessionStorage.setItem(WRITER_SESSION_KEY, pageWriterId);
  } catch {
    pageWriterId = newUniqueId('writer');
  }
  return pageWriterId;
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function encodedStepKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>): string {
  return `${encodeURIComponent(step.sessionId)}:${encodeURIComponent(step.id)}`;
}

function recordId(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>, writerId: string): string {
  return `${encodedStepKey(step)}:${encodeURIComponent(writerId)}`;
}

function metadataKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>, writerId: string): string {
  return `${METADATA_PREFIX}${recordId(step, writerId)}`;
}

function legacyKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>): string {
  return `${LEGACY_PREFIX}${encodedStepKey(step)}`;
}

function chunkOwnerPrefix(metadata: PersistedDescriptionDraftMetadata): string {
  return `${CHUNK_PREFIX}${recordId(
    { id: metadata.stepId, sessionId: metadata.sessionId },
    metadata.writerId,
  )}:`;
}

function isValidDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PERSISTED_STEP_LIMITS.maxDescriptionLength;
}

function isValidLength(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= PERSISTED_STEP_LIMITS.maxDescriptionLength;
}

function parseMetadata(raw: string | null): PersistedDescriptionDraftMetadata | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedDescriptionDraftMetadata> | null;
    if (
      !value ||
      value.version !== JOURNAL_VERSION ||
      !isValidIdentifier(value.writerId) ||
      !isValidIdentifier(value.stepId) ||
      !isValidIdentifier(value.sessionId) ||
      !isValidLength(value.baseLength) ||
      !isValidLength(value.descriptionLength) ||
      !Array.isArray(value.baseChunks) ||
      !Array.isArray(value.descriptionChunks) ||
      value.baseChunks.length !== Math.ceil(value.baseLength / CHUNK_CODE_UNITS) ||
      value.descriptionChunks.length !== Math.ceil(value.descriptionLength / CHUNK_CODE_UNITS) ||
      !value.baseChunks.every((key) => typeof key === 'string' && key.startsWith(CHUNK_PREFIX)) ||
      !value.descriptionChunks.every((key) => typeof key === 'string' && key.startsWith(CHUNK_PREFIX)) ||
      !Number.isFinite(value.updatedAt)
    ) return null;
    const metadata = value as PersistedDescriptionDraftMetadata;
    const owner = chunkOwnerPrefix(metadata);
    if (![...metadata.baseChunks, ...metadata.descriptionChunks].every((key) => key.startsWith(owner))) return null;
    return metadata;
  } catch {
    return null;
  }
}

function parseLegacy(raw: string | null): LegacyDescriptionDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LegacyDescriptionDraft> | null;
    if (
      !value ||
      value.version !== 1 ||
      !isValidIdentifier(value.stepId) ||
      !isValidIdentifier(value.sessionId) ||
      !isValidDescription(value.baseDescription) ||
      !isValidDescription(value.description) ||
      !Number.isFinite(value.updatedAt)
    ) return null;
    return value as LegacyDescriptionDraft;
  } catch {
    return null;
  }
}

function removeSafely(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function removeMetadataRecord(storage: Storage, key: string, metadata: PersistedDescriptionDraftMetadata | null): void {
  removeSafely(storage, key);
  if (!metadata || key !== metadataKey({ id: metadata.stepId, sessionId: metadata.sessionId }, metadata.writerId)) return;
  const owner = chunkOwnerPrefix(metadata);
  for (const chunkKey of new Set([...metadata.baseChunks, ...metadata.descriptionChunks])) {
    if (chunkKey.startsWith(owner)) removeSafely(storage, chunkKey);
  }
}

function readChunkedValue(storage: Storage, keys: readonly string[], expectedLength: number, owner: string): string | null {
  let result = '';
  try {
    for (const key of keys) {
      if (!key.startsWith(owner)) return null;
      const chunk = storage.getItem(key);
      if (chunk === null || chunk.length > CHUNK_CODE_UNITS) return null;
      result += chunk;
    }
  } catch {
    return null;
  }
  return result.length === expectedLength ? result : null;
}

function readMetadataValues(
  storage: Storage,
  metadata: PersistedDescriptionDraftMetadata,
): { baseDescription: string; description: string } | null {
  const owner = chunkOwnerPrefix(metadata);
  const baseDescription = readChunkedValue(storage, metadata.baseChunks, metadata.baseLength, owner);
  const description = readChunkedValue(storage, metadata.descriptionChunks, metadata.descriptionLength, owner);
  return baseDescription === null || description === null ? null : { baseDescription, description };
}

function storageKeys(storage: Storage): string[] | null {
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null,
    );
  } catch {
    return null;
  }
}

function isExpired(updatedAt: number, now: number): boolean {
  return now - updatedAt > DRAFT_MAX_AGE_MS || updatedAt > now + FUTURE_CLOCK_SKEW_MS;
}

function scanUsage(storage: Storage, now: number): { count: number; codeUnits: number; referencedChunks: Set<string> } | null {
  const keys = storageKeys(storage);
  if (!keys) return null;
  let count = 0;
  let codeUnits = 0;
  const referencedChunks = new Set<string>();
  try {
    for (const key of keys) {
      if (key.startsWith(METADATA_PREFIX)) {
        const metadata = parseMetadata(storage.getItem(key));
        if (
          !metadata ||
          key !== metadataKey({ id: metadata.stepId, sessionId: metadata.sessionId }, metadata.writerId) ||
          isExpired(metadata.updatedAt, now)
        ) {
          removeMetadataRecord(storage, key, metadata);
          continue;
        }
        count += 1;
        codeUnits += metadata.baseLength + metadata.descriptionLength;
        for (const chunkKey of [...metadata.baseChunks, ...metadata.descriptionChunks]) referencedChunks.add(chunkKey);
      } else if (key.startsWith(LEGACY_PREFIX)) {
        const legacy = parseLegacy(storage.getItem(key));
        if (!legacy || key !== legacyKey({ id: legacy.stepId, sessionId: legacy.sessionId }) || isExpired(legacy.updatedAt, now)) {
          removeSafely(storage, key);
          continue;
        }
        count += 1;
        codeUnits += legacy.baseDescription.length + legacy.description.length;
      }
    }
    return { count, codeUnits, referencedChunks };
  } catch {
    return null;
  }
}

function orphanCreatedAt(key: string): number | null {
  const match = /:(?:base|description):(\d+)-[^:]+:\d+$/u.exec(key);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function pruneOldOrphanChunks(storage: Storage, referencedChunks: ReadonlySet<string>, now: number): void {
  const keys = storageKeys(storage);
  if (!keys) return;
  for (const key of keys) {
    if (!key.startsWith(CHUNK_PREFIX) || referencedChunks.has(key)) continue;
    const createdAt = orphanCreatedAt(key);
    // A grace period prevents another tab from deleting copy-on-write chunks
    // between that tab's chunk writes and its metadata commit.
    if (createdAt !== null && now - createdAt > ORPHAN_GRACE_MS) removeSafely(storage, key);
  }
}

function writeChunkedValue(
  storage: Storage,
  id: string,
  kind: 'base' | 'description',
  value: string,
  previousKeys: readonly string[],
  revision: string,
  createdKeys: string[],
): string[] | null {
  const keys: string[] = [];
  try {
    for (let index = 0; index < Math.ceil(value.length / CHUNK_CODE_UNITS); index += 1) {
      const chunk = value.slice(index * CHUNK_CODE_UNITS, (index + 1) * CHUNK_CODE_UNITS);
      const previousKey = previousKeys[index];
      if (previousKey && storage.getItem(previousKey) === chunk) {
        keys.push(previousKey);
        continue;
      }
      const key = `${CHUNK_PREFIX}${id}:${kind}:${revision}:${index}`;
      storage.setItem(key, chunk);
      createdKeys.push(key);
      keys.push(key);
    }
    return keys;
  } catch {
    return null;
  }
}

/** Copy-on-write chunking keeps a crash-safe synchronous write bounded: normal
 * typing updates one 4 KiB chunk plus metadata instead of rewriting 100,000
 * characters. Metadata is committed last, so interrupted writes retain the
 * previous complete record. */
export function writeDescriptionDraft(
  step: DraftStepIdentity,
  description: string,
  writerId = getDescriptionDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): boolean {
  const storage = resolveStorage(storageOverride);
  if (
    !storage ||
    !isValidIdentifier(step.id) ||
    !isValidIdentifier(step.sessionId) ||
    !isValidDescription(step.description) ||
    !isValidIdentifier(writerId) ||
    !isValidDescription(description)
  ) return false;
  if (description === step.description) return discardDescriptionDraft(step, writerId, storage);

  const key = metadataKey(step, writerId);
  const usage = scanUsage(storage, now);
  if (!usage) return false;
  // Reclaim stale crash leftovers before allocating. Waiting until a successful
  // write creates a deadlock when those orphan chunks are what exhausted the
  // localStorage quota in the first place. Fresh cross-tab chunks remain
  // protected by ORPHAN_GRACE_MS.
  pruneOldOrphanChunks(storage, usage.referencedChunks, now);

  let previous: PersistedDescriptionDraftMetadata | null;
  try {
    previous = parseMetadata(storage.getItem(key));
    if (previous && readMetadataValues(storage, previous) === null) {
      usage.count = Math.max(0, usage.count - 1);
      usage.codeUnits = Math.max(0, usage.codeUnits - previous.baseLength - previous.descriptionLength);
      removeMetadataRecord(storage, key, previous);
      previous = null;
    }
  } catch {
    return false;
  }

  const nextCount = usage.count + (previous ? 0 : 1);
  const previousCodeUnits = previous ? previous.baseLength + previous.descriptionLength : 0;
  const nextCodeUnits = usage.codeUnits - previousCodeUnits + step.description.length + description.length;
  if (nextCount > MAX_DRAFT_RECORDS || nextCodeUnits > MAX_TOTAL_DRAFT_CODE_UNITS) return false;

  const id = recordId(step, writerId);
  const revision = `${now}-${newUniqueId('revision')}`;
  const createdKeys: string[] = [];
  const baseChunks = writeChunkedValue(storage, id, 'base', step.description, previous?.baseChunks ?? [], revision, createdKeys);
  const descriptionChunks = writeChunkedValue(
    storage,
    id,
    'description',
    description,
    previous?.descriptionChunks ?? [],
    revision,
    createdKeys,
  );
  if (!baseChunks || !descriptionChunks) {
    for (const createdKey of createdKeys) removeSafely(storage, createdKey);
    return false;
  }

  const metadata: PersistedDescriptionDraftMetadata = {
    version: JOURNAL_VERSION,
    writerId,
    stepId: step.id,
    sessionId: step.sessionId,
    baseLength: step.description.length,
    descriptionLength: description.length,
    baseChunks,
    descriptionChunks,
    updatedAt: now,
  };
  try {
    storage.setItem(key, JSON.stringify(metadata));
  } catch {
    for (const createdKey of createdKeys) removeSafely(storage, createdKey);
    return false;
  }

  const retained = new Set([...baseChunks, ...descriptionChunks]);
  if (previous) {
    const owner = chunkOwnerPrefix(previous);
    for (const oldKey of new Set([...previous.baseChunks, ...previous.descriptionChunks])) {
      if (oldKey.startsWith(owner) && !retained.has(oldKey)) removeSafely(storage, oldKey);
    }
  }
  pruneOldOrphanChunks(storage, usage.referencedChunks, now);
  return true;
}

/** Returns all independently journaled versions for one step. */
export function readDescriptionDrafts(
  step: DraftStepIdentity,
  currentWriterId = getDescriptionDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): RestoredDescriptionDraft[] {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidDescription(step.description)) return [];
  const usage = scanUsage(storage, now);
  if (!usage) return [];
  const keys = storageKeys(storage);
  if (!keys) return [];
  const candidates: RestoredDescriptionDraft[] = [];
  const stepPrefix = `${METADATA_PREFIX}${encodedStepKey(step)}:`;

  try {
    for (const key of keys) {
      if (!key.startsWith(stepPrefix)) continue;
      const metadata = parseMetadata(storage.getItem(key));
      if (!metadata || metadata.stepId !== step.id || metadata.sessionId !== step.sessionId) continue;
      const values = readMetadataValues(storage, metadata);
      if (!values) {
        removeMetadataRecord(storage, key, metadata);
        continue;
      }
      if (values.description === step.description) {
        removeMetadataRecord(storage, key, metadata);
        continue;
      }
      candidates.push({
        writerId: metadata.writerId,
        description: values.description,
        updatedAt: metadata.updatedAt,
        belongsToCurrentWriter: metadata.writerId === currentWriterId,
        conflictsWithPersistedValue: values.baseDescription !== step.description,
      });
    }

    const oldKey = legacyKey(step);
    const rawLegacy = storage.getItem(oldKey);
    const legacy = parseLegacy(rawLegacy);
    if (legacy && legacy.stepId === step.id && legacy.sessionId === step.sessionId && !isExpired(legacy.updatedAt, now)) {
      if (legacy.description === step.description) removeSafely(storage, oldKey);
      else {
        candidates.push({
          writerId: LEGACY_WRITER_ID,
          description: legacy.description,
          updatedAt: legacy.updatedAt,
          belongsToCurrentWriter: false,
          conflictsWithPersistedValue: legacy.baseDescription !== step.description,
        });
      }
    } else if (rawLegacy !== null) removeSafely(storage, oldKey);
  } catch {
    return [];
  }

  pruneOldOrphanChunks(storage, usage.referencedChunks, now);
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.writerId.localeCompare(right.writerId));
}

/** Compatibility helper returning the newest candidate. */
export function readDescriptionDraft(
  step: DraftStepIdentity,
  storageOverride?: Storage,
  now = Date.now(),
): RestoredDescriptionDraft | null {
  return readDescriptionDrafts(step, getDescriptionDraftWriterId(), storageOverride, now)[0] ?? null;
}

export function discardDescriptionDraft(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  writerId: string,
  storageOverride?: Storage,
): boolean {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidIdentifier(writerId)) return false;
  if (writerId === LEGACY_WRITER_ID) return removeSafely(storage, legacyKey(step));
  const key = metadataKey(step, writerId);
  try {
    const metadata = parseMetadata(storage.getItem(key));
    removeMetadataRecord(storage, key, metadata);
    return true;
  } catch {
    return false;
  }
}

/** Compare-and-clear prevents an older IndexedDB completion from deleting a
 * newer draft written by the same tab while that request was pending. */
export function clearCommittedDescriptionDraft(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  writerId: string,
  committedDescription: string,
  storageOverride?: Storage,
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage || writerId === LEGACY_WRITER_ID) return;
  const key = metadataKey(step, writerId);
  try {
    const metadata = parseMetadata(storage.getItem(key));
    if (!metadata) return;
    const values = readMetadataValues(storage, metadata);
    if (values?.description === committedDescription) removeMetadataRecord(storage, key, metadata);
  } catch {
    // The draft remains available for a later recovery attempt.
  }
}

/** Removes only candidates exactly equal to the authoritative IndexedDB value;
 * alternate drafts from other tabs remain selectable. */
export function clearMatchingCommittedDescriptionDrafts(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  committedDescription: string,
  storageOverride?: Storage,
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  const keys = storageKeys(storage);
  if (!keys) return;
  const stepPrefix = `${METADATA_PREFIX}${encodedStepKey(step)}:`;
  try {
    for (const key of keys) {
      if (!key.startsWith(stepPrefix)) continue;
      const metadata = parseMetadata(storage.getItem(key));
      if (!metadata || metadata.stepId !== step.id || metadata.sessionId !== step.sessionId) continue;
      if (readMetadataValues(storage, metadata)?.description === committedDescription) {
        removeMetadataRecord(storage, key, metadata);
      }
    }
    const oldKey = legacyKey(step);
    const legacy = parseLegacy(storage.getItem(oldKey));
    if (legacy?.description === committedDescription) removeSafely(storage, oldKey);
  } catch {
    // Best effort cleanup only; stale matching drafts are harmless and bounded.
  }
}

export const DESCRIPTION_DRAFT_JOURNAL_LIMITS = Object.freeze({
  maxRecords: MAX_DRAFT_RECORDS,
  maxTotalCodeUnits: MAX_TOTAL_DRAFT_CODE_UNITS,
  maxAgeMs: DRAFT_MAX_AGE_MS,
  chunkCodeUnits: CHUNK_CODE_UNITS,
  orphanGraceMs: ORPHAN_GRACE_MS,
});
