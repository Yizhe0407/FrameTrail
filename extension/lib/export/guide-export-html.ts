import type { GuideSection } from '../guide/guide-sections';
import type { StepEntry } from '../storage/db';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IMAGE_ALT,
  DEFAULT_TITLE,
  escapeGuideHtml,
  getSignal,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  throwIfAborted,
  type GuideExportControl,
  type GuideExportMetadata,
} from './guide-export-contract';
import { renderEntries, type RenderedEntry } from './guide-export-render';

/**
 * Generates a self-contained HTML publication. It uses only fixed template
 * markup and data-URI images; all metadata and descriptions pass through
 * text escaping before interpolation.
 */
export async function generateGuideHtml(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  return generateGuideHtmlDocument(entries, metadata, getSignal(control));
}

async function generateGuideHtmlDocument(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata,
  signal?: AbortSignal,
): Promise<string> {
  const renderedEntries = await renderEntries(entries, signal);
  throwIfAborted(signal);

  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const description = textValue(metadata.description);
  const header = [
    `<div class="guide-overline"><span>FrameTrail Guide</span></div>`,
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const sections = sectionsByStartEntry(metadata.sections, entries);
  const stepChunks: string[] = [];
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      stepChunks.push(renderHtmlSectionHeading(section));
    }
    stepChunks.push(renderHtmlEntry(entry));
  }
  const steps = stepChunks.join('\n');
  throwIfAborted(signal);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'">
<title>${escapeGuideHtml(title)}</title>
<style>
${BASE_STYLE}
</style>
</head>
<body class="guide-document">
<main class="guide">
<header class="guide-header">
${header}
</header>
<div class="guide-content">
${steps}
</div>
</main>
</body>
</html>
`;
}

function renderHtmlSectionHeading(section: GuideSection): string {
  return `<section class="guide-section-heading">
<p>Section</p>
<h2>${htmlText(section.title)}</h2>
</section>`;
}

function renderHtmlEntry(entry: RenderedEntry): string {
  const text = entry.annotations.length === 0
    ? `<p class="step-description">${htmlText(textOrDefault(entry.description, DEFAULT_DESCRIPTION))}</p>`
    : renderHtmlAnnotations(entry);
  const alt = escapeGuideHtml(textOrDefault(entry.description, DEFAULT_IMAGE_ALT));

  return `<section class="guide-step">
<figure>
<img src="${entry.imageDataUri}" alt="${alt}">
</figure>
${text}
</section>`;
}

function renderHtmlAnnotations(entry: RenderedEntry): string {
  const description = textValue(entry.description);
  const intro = description ? `<p class="step-description">${htmlText(description)}</p>\n` : '';
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}</li>`)
    .join('\n');
  return `${intro}<div class="annotation-list">
<ol>
${items}
</ol>
</div>`;
}


function htmlText(value: string): string {
  return escapeGuideHtml(value).replace(/\r\n?|\n/g, '<br>');
}

const BASE_STYLE = `
:root {
  color-scheme: light;
  --canvas: #f5f5f4;
  --surface: #ffffff;
  --surface-muted: #fafaf9;
  --text: #1c1917;
  --text-muted: #57534e;
  --line: #d6d3d1;
  --line-soft: #e7e5e4;
  --accent: #4d7c0f;
  --accent-soft: #ecfccb;
  font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { background: var(--canvas); }
body { margin: 0; background: var(--canvas); color: var(--text); font-size: 16px; line-height: 1.65; }
.guide { width: min(calc(100% - 32px), 1040px); margin: 0 auto; padding: 40px 0 64px; }
.guide-header {
  margin-bottom: 28px;
  padding: 34px 36px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 16px;
  background: linear-gradient(145deg, #ffffff 0%, #fafaf9 74%, #f7fee7 100%);
  box-shadow: 0 12px 32px rgb(28 25 23 / 0.06);
}
.guide-overline { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; color: var(--accent); font-size: .75rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
h1, h2, h3, h4 { color: var(--text); line-height: 1.25; text-wrap: balance; }
h1 { max-width: 22ch; margin: 0; font-size: clamp(2rem, 5vw, 3.35rem); letter-spacing: -.035em; }
h2 { margin: 0; font-size: 1.45rem; }
h3 { margin: 0; font-size: 1.2rem; }
h4 { margin: 0; font-size: 1rem; }
p { margin: 0; }
ol { margin: 10px 0 0; padding-left: 1.5rem; }
li { padding-left: .3rem; }
li + li { margin-top: 7px; }
.guide-description { max-width: 68ch; margin-top: 16px; color: var(--text-muted); font-size: 1.05rem; }
.guide-content { display: flow-root; }
.guide-section-heading { margin: 44px 0 18px; padding: 0 4px 12px; border-bottom: 1px solid var(--line); }
.guide-section-heading p { margin-bottom: 4px; color: var(--accent); font-size: .72rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.guide-section-heading h2 { font-size: 1.65rem; }
.guide-step {
  margin: 0 0 20px;
  padding: 26px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(28 25 23 / 0.045);
}
.step-description { max-width: 72ch; margin-bottom: 16px; color: #292524; white-space: normal; }
.annotation-list { margin-bottom: 18px; padding: 16px 18px; border-left: 3px solid #84cc16; border-radius: 0 8px 8px 0; background: var(--surface-muted); }
figure { margin: 0 0 18px; }
img { display: block; width: auto; max-width: 100%; height: auto; margin-inline: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--canvas); }
@media (max-width: 640px) {
  .guide { width: min(calc(100% - 20px), 1040px); padding: 18px 0 36px; }
  .guide-header { padding: 24px 20px; border-radius: 12px; }
  .guide-overline { align-items: flex-start; flex-direction: column; gap: 4px; }
  .guide-step { padding: 18px 16px; border-radius: 10px; }
}
`;
