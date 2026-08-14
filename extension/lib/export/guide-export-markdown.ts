import { throwIfAborted } from '../shared/abort';
import { strToU8 } from 'fflate';
import { type StepEntry } from '../storage/models';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IMAGE_ALT,
  DEFAULT_TITLE,
  escapeGuideMarkdown,
  guideExportFilename,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type GuideExportMetadata,
  type GuideExportOptions,
  type GuideMarkdownArchive,
} from './guide-export-contract';
import {
  renderEntryImages,
  type RenderedEntryContent,
  type RenderedMarkdownEntry,
} from './guide-export-render';

/**
 * Builds a portable Markdown ZIP containing one Markdown document and every
 * composited guide image under images/. The Markdown uses relative paths so
 * the archive remains editable without embedding large data URIs.
 */
export async function generateGuideMarkdownArchive(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  options: GuideExportOptions = {},
): Promise<GuideMarkdownArchive> {
  const { signal } = options;
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
    // Text-first reading order matches the HTML and PDF publications: the step
    // description leads, its screenshot follows, then any group annotations.
    const description = textValue(entry.description);
    if (description || entry.annotations.length === 0) {
      lines.push('', escapeGuideMarkdown(textOrDefault(description, DEFAULT_DESCRIPTION)));
    }
    const alt = textOrDefault(entry.description, DEFAULT_IMAGE_ALT);
    lines.push('', `![${escapeGuideMarkdown(alt)}](${imageReference(entry)})`);
    if (entry.annotations.length > 0) {
      lines.push('');
      for (const [index, annotation] of entry.annotations.entries()) {
        lines.push(`${index + 1}. ${escapeGuideMarkdown(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

