import { throwIfAborted } from '../shared/abort';
import type { GuideSection } from '../guide/guide-sections';
import type { StepEntry } from '../storage/db';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IMAGE_ALT,
  DEFAULT_TITLE,
  escapeGuideHtml,
  formatGuideCreatedAt,
  getSignal,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
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
  const metaParts = [`共 ${renderedEntries.length} 個步驟`];
  const createdAt = formatGuideCreatedAt(metadata.createdAt);
  if (createdAt) metaParts.push(`建立於 ${createdAt}`);
  const header = [
    `<p class="guide-overline">FrameTrail</p>`,
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
    `<p class="guide-meta">${metaParts.map((part) => `<span>${escapeGuideHtml(part)}</span>`).join('\n')}</p>`,
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
<p class="guide-section-label">章節</p>
<h2>${htmlText(section.title)}</h2>
</section>`;
}

function renderHtmlEntry(entry: RenderedEntry): string {
  const heading = htmlText(textOrDefault(entry.description, DEFAULT_DESCRIPTION));
  const alt = escapeGuideHtml(textOrDefault(entry.description, DEFAULT_IMAGE_ALT));
  const annotations = entry.annotations.length > 0 ? renderHtmlAnnotations(entry) : '';

  return [
    `<section class="guide-step">`,
    `<div class="step-heading">`,
    `<span class="step-number" aria-hidden="true">${entry.ordinal}</span>`,
    `<h3 class="step-title">${heading}</h3>`,
    `</div>`,
    `<figure>`,
    `<img src="${entry.imageDataUri}" alt="${alt}">`,
    `</figure>`,
    annotations,
    `</section>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHtmlAnnotations(entry: RenderedEntry): string {
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}</li>`)
    .join('\n');
  return `<div class="annotation-list">
<ol>
${items}
</ol>
</div>`;
}

function htmlText(value: string): string {
  return escapeGuideHtml(value).replace(/\r\n?|\n/g, '<br>');
}

/**
 * Document stylesheet tuned for zh-Hant step guides: system CJK font stack,
 * >=1.7 body leading, a comfortable centered reading column, numbered step
 * cards, light/dark schemes, and an ink-friendly A4 print layout.
 */
const BASE_STYLE = `
:root {
  color-scheme: light;
  --canvas: #f5f6f8;
  --surface: #ffffff;
  --surface-muted: #f2f4f7;
  --text: #1d2129;
  --text-secondary: #454d59;
  --text-muted: #6d7585;
  --line: #e2e5ea;
  --line-soft: #eceef2;
  --accent: #3e63c4;
  --accent-contrast: #ffffff;
  --card-shadow: 0 1px 2px rgb(23 26 31 / 0.04), 0 8px 24px rgb(23 26 31 / 0.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --canvas: #111318;
    --surface: #191c23;
    --surface-muted: #20242d;
    --text: #e7e9ee;
    --text-secondary: #c3c8d2;
    --text-muted: #8f97a6;
    --line: #2b303b;
    --line-soft: #252a33;
    --accent: #7c9aea;
    --accent-contrast: #10141d;
    --card-shadow: 0 1px 2px rgb(0 0 0 / 0.35), 0 10px 28px rgb(0 0 0 / 0.3);
  }
}
* { box-sizing: border-box; }
html { background: var(--canvas); }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
p { margin: 0; }
.guide { width: min(100% - 40px, 760px); margin: 0 auto; padding: 48px 0 72px; }
.guide-header {
  margin-bottom: 32px;
  padding: 36px 40px 30px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-left: 4px solid var(--accent);
  border-radius: 12px;
  box-shadow: var(--card-shadow);
}
.guide-overline {
  margin-bottom: 14px;
  color: var(--accent);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  color: var(--text);
  font-size: clamp(1.75rem, 4.5vw, 2.5rem);
  line-height: 1.3;
  letter-spacing: -.015em;
  text-wrap: balance;
}
.guide-description {
  max-width: 70ch;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: 1.0625rem;
}
.guide-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
  color: var(--text-muted);
  font-size: .875rem;
}
.guide-meta span + span::before { content: "·"; margin: 0 10px; }
.guide-content { display: flow-root; }
.guide-section-heading { margin: 48px 0 20px; padding-bottom: 10px; border-bottom: 2px solid var(--line); }
.guide-section-heading:first-child { margin-top: 8px; }
.guide-section-label {
  margin-bottom: 4px;
  color: var(--accent);
  font-size: .72rem;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.guide-section-heading h2 { margin: 0; color: var(--text); font-size: 1.5rem; line-height: 1.4; }
.guide-step {
  margin: 0 0 24px;
  padding: 24px 28px 28px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  box-shadow: var(--card-shadow);
}
.step-heading { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
.step-number {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-top: 2px;
  background: var(--accent);
  border-radius: 999px;
  color: var(--accent-contrast);
  font-size: .9375rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.step-title {
  margin: 0;
  max-width: 66ch;
  color: var(--text);
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.7;
}
figure { margin: 0; }
img {
  display: block;
  max-width: 100%;
  height: auto;
  margin-inline: auto;
  background: var(--surface-muted);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.annotation-list {
  margin-top: 18px;
  padding: 14px 20px;
  background: var(--surface-muted);
  border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
}
.annotation-list ol { margin: 0; padding-left: 1.4rem; }
.annotation-list li { max-width: 66ch; padding-left: .35rem; }
.annotation-list li + li { margin-top: 8px; }
@media (max-width: 640px) {
  .guide { width: min(100% - 24px, 760px); padding: 20px 0 48px; }
  .guide-header { padding: 24px 20px; }
  .guide-step { padding: 18px 16px 20px; }
  .step-heading { gap: 10px; }
}
@page { size: A4; margin: 16mm; }
@media print {
  :root {
    color-scheme: light;
    --canvas: #ffffff;
    --surface: #ffffff;
    --surface-muted: #ffffff;
    --text: #111111;
    --text-secondary: #333333;
    --text-muted: #555555;
    --line: #c8c8c8;
    --line-soft: #dcdcdc;
    --accent: #2f4d9e;
    --accent-contrast: #ffffff;
    --card-shadow: none;
  }
  html, body { background: #ffffff; }
  body { font-size: 11pt; line-height: 1.7; }
  .guide { width: 100%; padding: 0; }
  .guide-header {
    margin-bottom: 18pt;
    padding: 0 0 12pt;
    border: 0;
    border-bottom: 2pt solid #111111;
    border-radius: 0;
  }
  .guide-section-heading { break-after: avoid; page-break-after: avoid; }
  .guide-step {
    break-inside: avoid;
    page-break-inside: avoid;
    margin-bottom: 14pt;
    padding: 0 0 14pt;
    border: 0;
    border-bottom: 1pt solid var(--line-soft);
    border-radius: 0;
  }
  .step-number { background: #ffffff; border: 1.5pt solid var(--accent); color: var(--accent); }
  img { max-height: 150mm; border-radius: 4pt; }
  .annotation-list { border: 1pt solid var(--line); border-left: 3pt solid var(--accent); border-radius: 0; }
}
`;
