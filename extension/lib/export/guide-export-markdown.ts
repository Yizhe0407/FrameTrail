import { strToU8, Zip, ZipPassThrough } from 'fflate';
import type { StepEntry } from '../storage/db';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IMAGE_ALT,
  DEFAULT_TITLE,
  escapeGuideMarkdown,
  getSignal,
  guideExportFilename,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  throwIfAborted,
  type GuideExportControl,
  type GuideExportMetadata,
  type GuideMarkdownArchive,
} from './guide-export-contract';
import {
  renderEntries,
  renderEntryImages,
  type RenderedEntryContent,
  type RenderedMarkdownEntry,
} from './guide-export-render';

/**
 * Generates a self-contained Markdown publication. Every image is embedded as
 * a composited JPEG data URI, so the file remains usable without a server or a
 * sibling asset directory.
 */
export async function generateGuideMarkdown(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  const signal = getSignal(control);
  const renderedEntries = await renderEntries(entries, signal);
  throwIfAborted(signal);

  return renderGuideMarkdown(renderedEntries, entries, metadata, (entry) => entry.imageDataUri);
}

/**
 * Builds a portable Markdown ZIP containing one Markdown document and every
 * composited guide image under images/. The Markdown uses relative paths so
 * the archive remains editable without embedding large data URIs.
 */
export async function generateGuideMarkdownArchive(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<GuideMarkdownArchive> {
  const signal = getSignal(control);
  const markdownEntries: RenderedMarkdownEntry[] = [];
  const markdownFilename = guideExportFilename(metadata, 'markdown');
  const pad = Math.max(2, String(entries.length).length);
  const { archive, result } = createStreamingZip();

  try {
    for await (const rendered of renderEntryImages(entries, signal)) {
      const imageReference = `images/${String(rendered.content.ordinal).padStart(pad, '0')}.jpg`;
      addZipFile(archive, imageReference, rendered.imageBytes);
      markdownEntries.push({ ...rendered.content, imageReference });
    }

    throwIfAborted(signal);
    const markdown = renderGuideMarkdown(
      markdownEntries,
      entries,
      metadata,
      (entry) => entry.imageReference,
    );
    addZipFile(archive, markdownFilename, strToU8(markdown));
    archive.end();
  } catch (error) {
    archive.terminate();
    throw error;
  }

  const blob = await result;
  throwIfAborted(signal);
  return { blob, markdownFilename, imageCount: markdownEntries.length };
}

function renderGuideMarkdown<T extends RenderedEntryContent>(
  renderedEntries: readonly T[],
  sourceEntries: readonly StepEntry[],
  metadata: GuideExportMetadata,
  imageReference: (entry: T) => string,
): string {
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const lines = [`# ${escapeGuideMarkdown(title)}`];
  const description = textValue(metadata.description);
  if (description) lines.push('', escapeGuideMarkdown(description));

  const sections = sectionsByStartEntry(metadata.sections, sourceEntries);
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      lines.push('', `## ${escapeGuideMarkdown(section.title)}`);
    }
    const alt = textOrDefault(entry.description, DEFAULT_IMAGE_ALT);
    lines.push('', `![${escapeGuideMarkdown(alt)}](${imageReference(entry)})`);
    appendMarkdownEntryText(lines, entry);
  }

  return `${lines.join('\n')}\n`;
}

function appendMarkdownEntryText(lines: string[], entry: RenderedEntryContent): void {
  if (entry.annotations.length === 0) {
    lines.push('', escapeGuideMarkdown(textOrDefault(entry.description, DEFAULT_DESCRIPTION)));
  } else {
    const description = textValue(entry.description);
    if (description) lines.push('', escapeGuideMarkdown(description));
    for (const [index, annotation] of entry.annotations.entries()) {
      lines.push(`${index + 1}. ${escapeGuideMarkdown(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}`);
    }
  }
}


function createStreamingZip(): { archive: Zip; result: Promise<Blob> } {
  const chunks: ArrayBuffer[] = [];
  let resolveZip!: (value: Blob) => void;
  let rejectZip!: (reason: unknown) => void;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });

  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectZip(error);
      return;
    }
    // fflate may reuse its output buffer after the callback.
    const owned = new Uint8Array(chunk.byteLength);
    owned.set(chunk);
    chunks.push(owned.buffer);
    if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
  });

  return { archive, result };
}

function addZipFile(archive: Zip, filename: string, bytes: Uint8Array): void {
  const file = new ZipPassThrough(filename);
  archive.add(file);
  file.push(bytes, true);
}
