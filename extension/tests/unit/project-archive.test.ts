import { describe, expect, it } from 'vitest';

import type { Step } from '@/lib/db';
import type { ProjectArchiveMetadataInput } from '@/lib/project-archive';
import {
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LEGACY_VERSION,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_MIME_TYPE,
  PROJECT_ARCHIVE_VERSION,
  exportProjectArchive,
  importProjectArchive,
  serializeProjectArchive,
} from '@/lib/project-archive';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    screenshotBlob: new Blob([new Uint8Array([0, 1, 2, 127, 128, 255])], { type: 'image/png' }),
    bounds: { x: 12.5, y: -4, width: 100, height: 50 },
    devicePixelRatio: 2,
    description: 'Click the button',
    url: 'https://example.com/path?q=one#section',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

async function archiveObject(
  steps: readonly Step[] = [makeStep()],
  metadata?: ProjectArchiveMetadataInput,
): Promise<any> {
  return JSON.parse(await serializeProjectArchive(steps, { metadata }));
}

async function blobBytes(blob: Blob | undefined): Promise<number[] | undefined> {
  return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : undefined;
}

describe('project archive', () => {
  it('round-trips complete Step data, groups, redactions, and binary screenshot Blobs', async () => {
    const ordinary = makeStep({
      id: 'ordinary',
      runId: 'run-1',
      manualBounds: { x: 10, y: 11, width: 90, height: 45 },
      redactions: [
        { id: 'mask-1', kind: 'solid', bounds: { x: 2, y: 3, width: 20, height: 10 } },
      ],
      redactionReviewRequired: false,
      screenshotScale: 1.5,
      description: '<img src=x onerror="globalThis.executed=true"> & editable text',
      captureRevision: 3,
      lastCaptureRunId: 'capture-run-3',
    });
    const anchor = makeStep({
      id: 'anchor',
      order: 1,
      screenshotBlob: new Blob(['shared jpeg bytes'], { type: 'image/jpeg' }),
      bounds: null,
      groupId: 'anchor',
      numbered: true,
    });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      groupId: 'anchor',
      numbered: true,
      description: 'Annotation',
    });

    const archive = await exportProjectArchive([annotation, anchor, ordinary]);
    expect(archive.type).toBe(PROJECT_ARCHIVE_MIME_TYPE);

    const encoded = JSON.parse(await archive.text());
    expect(encoded.manifest).toMatchObject({
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      stepCount: 3,
      blobCount: 2,
    });
    expect(encoded.manifest.steps.map((step: any) => step.id)).toEqual(['ordinary', 'anchor', 'annotation']);
    expect(encoded.blobs.map((blob: any) => blob.id)).toEqual(['screenshot-000001', 'screenshot-000002']);

    const restored = await importProjectArchive(archive);
    const expected = [ordinary, anchor, annotation];
    expect(restored.map((step) => step.id)).not.toEqual(expected.map((step) => step.id));
    expect(new Set(restored.map((step) => step.sessionId)).size).toBe(1);
    expect(restored[1].groupId).toBe(restored[1].id);
    expect(restored[2].groupId).toBe(restored[1].id);
    for (let index = 0; index < expected.length; index += 1) {
      expect(restored[index]).toMatchObject({
        order: expected[index].order,
        bounds: expected[index].bounds,
        devicePixelRatio: expected[index].devicePixelRatio,
        description: expected[index].description,
        url: expected[index].url,
        timestamp: expected[index].timestamp,
      });
      expect(await blobBytes(restored[index].screenshotBlob)).toEqual(await blobBytes(expected[index].screenshotBlob));
      expect(restored[index].screenshotBlob?.type).toBe(expected[index].screenshotBlob?.type);
      if (expected[index].screenshotBlob) expect(restored[index].screenshotBlob).not.toBe(expected[index].screenshotBlob);
    }
    expect(restored[0].description).toContain('onerror=');
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined();
  });

  it('produces deterministic canonical JSON regardless of input step order', async () => {
    const first = makeStep({ id: 'b', order: 4, screenshotBlob: new Blob(['b'], { type: 'image/png' }) });
    const second = makeStep({ id: 'a', order: 4, screenshotBlob: new Blob(['a'], { type: 'image/png' }) });

    const forward = await serializeProjectArchive([first, second]);
    const reverse = await serializeProjectArchive([second, first]);

    expect(forward).toBe(reverse);
    expect(JSON.parse(forward).manifest.steps.map((step: any) => step.id)).toEqual(['a', 'b']);
  });

  it('imports legacy v1 archives and exposes empty metadata through the opt-in overload', async () => {
    const archive = await archiveObject();
    archive.manifest.version = PROJECT_ARCHIVE_LEGACY_VERSION;
    delete archive.manifest.metadata;

    const imported = await importProjectArchive(JSON.stringify(archive), { includeMetadata: true });

    expect(imported.version).toBe(PROJECT_ARCHIVE_LEGACY_VERSION);
    expect(imported.metadata).toEqual({ title: '', description: '', sections: [] });
    expect(imported.steps).toHaveLength(1);
    expect(imported.steps[0].id).not.toBe('step-1');
    expect(imported.steps[0].sessionId).not.toBe('session-1');
  });

  it('round-trips v2 metadata, remaps section boundaries, and repairs stale or duplicate sections', async () => {
    const first = makeStep({ id: 'first', order: 0 });
    const anchor = makeStep({ id: 'anchor', order: 1, bounds: null, groupId: 'anchor', numbered: true });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      groupId: 'anchor',
      numbered: true,
    });
    const last = makeStep({ id: 'last', order: 3 });
    const archive = await archiveObject([last, annotation, anchor, first], {
      title: 'Safe guide',
      description: 'Local backup',
      sections: [
        { id: 'last-section', title: 'Last', startEntryId: 'last' },
        { id: 'first-section', title: '  First\nchapter  ', startEntryId: 'first' },
        { id: 'duplicate-id', title: 'Anchor', startEntryId: 'anchor' },
        { id: 'duplicate-id', title: 'Later duplicate id', startEntryId: 'last' },
        { id: 'duplicate-start', title: 'Later duplicate start', startEntryId: 'first' },
        { id: 'annotation-section', title: 'Must be dropped', startEntryId: 'annotation' },
        { id: 'missing-section', title: 'Must be dropped', startEntryId: 'missing' },
      ],
    });

    expect(archive.manifest.version).toBe(PROJECT_ARCHIVE_VERSION);
    expect(archive.manifest.metadata.sections.map((section: any) => section.startEntryId)).toEqual([
      'first',
      'anchor',
      'last',
    ]);

    const imported = await importProjectArchive(JSON.stringify(archive), { includeMetadata: true });
    const [remappedFirst, remappedAnchor, remappedAnnotation, remappedLast] = imported.steps;
    expect(imported.version).toBe(PROJECT_ARCHIVE_VERSION);
    expect(imported.metadata.title).toBe('Safe guide');
    expect(imported.metadata.description).toBe('Local backup');
    expect(imported.metadata.sections).toEqual([
      { id: 'first-section', title: 'Firstchapter', startEntryId: remappedFirst.id },
      { id: 'duplicate-id', title: 'Anchor', startEntryId: remappedAnchor.id },
      { id: 'last-section', title: 'Last', startEntryId: remappedLast.id },
    ]);
    expect(remappedAnchor.groupId).toBe(remappedAnchor.id);
    expect(remappedAnnotation.groupId).toBe(remappedAnchor.id);
    expect(imported.metadata.sections.some((section) => section.startEntryId === remappedAnnotation.id)).toBe(false);
    expect(new Set(imported.steps.map((step) => step.sessionId)).size).toBe(1);
    expect(imported.steps.every((step) => !['first', 'anchor', 'annotation', 'last'].includes(step.id))).toBe(true);
  });

  it('repairs duplicate, missing, and annotation-middle sections from an untrusted v2 archive', async () => {
    const first = makeStep({ id: 'first', order: 0 });
    const anchor = makeStep({ id: 'anchor', order: 1, bounds: null, groupId: 'anchor' });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      groupId: 'anchor',
    });
    const archive = await archiveObject([first, anchor, annotation]);
    archive.manifest.metadata.sections = [
      { id: 'winner', title: 'Winner', startEntryId: 'first' },
      { id: 'winner', title: 'Duplicate id', startEntryId: 'anchor' },
      { id: 'duplicate-start', title: 'Duplicate start', startEntryId: 'first' },
      { id: 'annotation-middle', title: 'Annotation middle', startEntryId: 'annotation' },
      { id: 'missing', title: 'Missing', startEntryId: 'does-not-exist' },
    ];

    const imported = await importProjectArchive(JSON.stringify(archive), { includeMetadata: true });

    expect(imported.metadata.sections).toEqual([
      { id: 'winner', title: 'Winner', startEntryId: imported.steps[0].id },
    ]);
  });

  it('rejects unknown v2 metadata/section fields and oversized metadata', async () => {
    const unknownMetadata = await archiveObject();
    unknownMetadata.manifest.metadata.html = '<script>alert(1)</script>';
    await expect(importProjectArchive(JSON.stringify(unknownMetadata))).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });

    const unknownSection = await archiveObject([makeStep()], {
      sections: [{ id: 'section', title: 'Section', startEntryId: 'step-1' }],
    });
    unknownSection.manifest.metadata.sections[0].style = 'display:none';
    await expect(importProjectArchive(JSON.stringify(unknownSection))).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });

    await expect(serializeProjectArchive([makeStep()], {
      metadata: { title: 'x'.repeat(PROJECT_ARCHIVE_LIMITS.maxTitleLength + 1) },
    })).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const oversizedSection = await archiveObject([makeStep()], {
      sections: [{ id: 'section', title: 'Section', startEntryId: 'step-1' }],
    });
    oversizedSection.manifest.metadata.sections[0].title = 'x'.repeat(
      PROJECT_ARCHIVE_LIMITS.maxSectionTitleLength + 1,
    );
    await expect(importProjectArchive(JSON.stringify(oversizedSection))).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });

    const tooManySections = Array.from({ length: PROJECT_ARCHIVE_LIMITS.maxSections + 1 }, (_, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: 'step-1',
    }));
    await expect(serializeProjectArchive([makeStep()], {
      metadata: { sections: tooManySections },
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects unknown future archive versions explicitly', async () => {
    const archive = await archiveObject();
    archive.manifest.version = PROJECT_ARCHIVE_VERSION + 1;

    await expect(importProjectArchive(JSON.stringify(archive))).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('rejects duplicate step, screenshot, and redaction ids', async () => {
    const duplicateSteps = await archiveObject();
    duplicateSteps.manifest.steps.push({ ...duplicateSteps.manifest.steps[0], screenshotBlobId: undefined });
    delete duplicateSteps.manifest.steps[1].screenshotBlobId;
    duplicateSteps.manifest.stepCount = 2;
    await expect(importProjectArchive(JSON.stringify(duplicateSteps))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });

    const duplicateBlobs = await archiveObject();
    duplicateBlobs.blobs.push({ ...duplicateBlobs.blobs[0] });
    duplicateBlobs.manifest.blobCount = 2;
    await expect(importProjectArchive(JSON.stringify(duplicateBlobs))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });

    const duplicateRedactions = await archiveObject();
    duplicateRedactions.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'solid', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { id: 'mask', kind: 'solid', bounds: { x: 2, y: 2, width: 1, height: 1 } },
    ];
    await expect(importProjectArchive(JSON.stringify(duplicateRedactions))).rejects.toMatchObject({
      code: 'DUPLICATE_ID',
    });
  });

  it('rejects missing and malformed snapshot group anchors', async () => {
    const missingAnchor = await archiveObject();
    missingAnchor.manifest.steps[0].groupId = 'missing';
    missingAnchor.manifest.steps[0].numbered = true;
    await expect(importProjectArchive(JSON.stringify(missingAnchor))).rejects.toMatchObject({
      code: 'BROKEN_GROUP_REFERENCE',
    });

    const malformedAnchor = await archiveObject();
    malformedAnchor.manifest.steps[0].groupId = 'step-1';
    malformedAnchor.manifest.steps[0].numbered = true;
    await expect(importProjectArchive(JSON.stringify(malformedAnchor))).rejects.toMatchObject({
      code: 'BROKEN_GROUP_REFERENCE',
    });
  });

  it('rejects malformed redactions and invalid bounds', async () => {
    const badKind = await archiveObject();
    badKind.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'blur', bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    await expect(importProjectArchive(JSON.stringify(badKind))).rejects.toMatchObject({ code: 'INVALID_REDACTION' });

    const zeroWidth = await archiveObject();
    zeroWidth.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'solid', bounds: { x: 0, y: 0, width: 0, height: 1 } },
    ];
    await expect(importProjectArchive(JSON.stringify(zeroWidth))).rejects.toMatchObject({
      code: 'INVALID_REDACTION',
    });

    const hugeBounds = await archiveObject();
    hugeBounds.manifest.steps[0].bounds.width = PROJECT_ARCHIVE_LIMITS.maxBoundsDimension + 1;
    await expect(importProjectArchive(JSON.stringify(hugeBounds))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('rejects unsafe URLs without interpreting HTML-like text', async () => {
    const javascriptUrl = await archiveObject();
    javascriptUrl.manifest.steps[0].url = 'javascript:alert(document.domain)';
    await expect(importProjectArchive(JSON.stringify(javascriptUrl))).rejects.toMatchObject({ code: 'UNSAFE_URL' });

    const credentialUrl = await archiveObject();
    credentialUrl.manifest.steps[0].url = 'https://user:secret@example.com/private';
    await expect(importProjectArchive(JSON.stringify(credentialUrl))).rejects.toMatchObject({ code: 'UNSAFE_URL' });

    await expect(importProjectArchive('<script>globalThis.executed=true</script>')).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined();
  });

  it('rejects non-canonical base64, mismatched sizes, unsafe image types, and unused blobs', async () => {
    const badBase64 = await archiveObject();
    badBase64.blobs[0].data = 'A===';
    await expect(importProjectArchive(JSON.stringify(badBase64))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const wrongSize = await archiveObject();
    wrongSize.blobs[0].size += 1;
    await expect(importProjectArchive(JSON.stringify(wrongSize))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const svg = await archiveObject();
    svg.blobs[0].mediaType = 'image/svg+xml';
    await expect(importProjectArchive(JSON.stringify(svg))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const unused = await archiveObject();
    delete unused.manifest.steps[0].screenshotBlobId;
    await expect(importProjectArchive(JSON.stringify(unused))).rejects.toMatchObject({ code: 'INVALID_BLOB' });
  });

  it('enforces count, string, and schema bounds', async () => {
    const tooMany = Array.from({ length: PROJECT_ARCHIVE_LIMITS.maxSteps + 1 }, (_, index) =>
      makeStep({ id: `step-${index}`, screenshotBlob: undefined }),
    );
    await expect(serializeProjectArchive(tooMany)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    await expect(
      serializeProjectArchive([
        makeStep({ description: 'x'.repeat(PROJECT_ARCHIVE_LIMITS.maxDescriptionLength + 1) }),
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
    await expect(serializeProjectArchive([makeStep({ description: 'bad\u0000text' })])).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });

    const unknownField = await archiveObject();
    unknownField.manifest.steps[0].html = '<script>alert(1)</script>';
    await expect(importProjectArchive(JSON.stringify(unknownField))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('supports AbortSignal before and during Blob reads', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(serializeProjectArchive([makeStep()], { signal: alreadyAborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const duringRead = new AbortController();
    class AbortingBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        duringRead.abort();
        return super.arrayBuffer();
      }
    }
    await expect(
      serializeProjectArchive([
        makeStep({ screenshotBlob: new AbortingBlob(['image'], { type: 'image/png' }) }),
      ], { signal: duringRead.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const importAbort = new AbortController();
    const validText = await serializeProjectArchive([makeStep()]);
    class AbortingArchiveBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        importAbort.abort();
        return super.arrayBuffer();
      }
    }
    await expect(
      importProjectArchive(new AbortingArchiveBlob([validText]), { signal: importAbort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
