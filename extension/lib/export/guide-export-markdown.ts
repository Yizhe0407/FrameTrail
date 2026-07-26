import { throwIfAborted } from '../shared/abort';
import { strToU8 } from 'fflate';
import type { StepEntry } from '../storage/db';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';
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

  const blob = await buildZipBlob(async (addFile) => {
    for await (const rendered of renderEntryImages(entries, signal)) {
      const imageReference = `images/${paddedZipOrdinal(rendered.content.ordinal, entries.length)}.jpg`;
      addFile(imageReference, rendered.imageBytes);
      markdownEntries.push({ ...rendered.content, imageReference });
    }

    throwIfAborted(signal);
    const markdown = renderGuideMarkdown(
      markdownEntries,
      entries,
      metadata,
      (entry) => entry.imageReference,
    );
    addFile(markdownFilename, strToU8(markdown));
  });
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

