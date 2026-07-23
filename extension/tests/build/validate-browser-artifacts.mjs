import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

async function readManifest(directory) {
  const manifestPath = path.join(root, '.output', directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return { manifest, manifestPath, directory };
}

async function requireFiles(build, files) {
  for (const file of files) await access(path.join(root, '.output', build.directory, file));
}

const chrome = await readManifest('chrome-mv3');
const firefox = await readManifest('firefox-mv2');

if (chrome.manifest.manifest_version !== 3 || chrome.manifest.background?.service_worker !== 'background.js') {
  throw new Error(`Invalid Chrome MV3 background manifest: ${chrome.manifestPath}`);
}
if (chrome.manifest.action?.default_popup !== 'popup.html') {
  throw new Error(`Chrome popup is missing from ${chrome.manifestPath}`);
}
if ((chrome.manifest.host_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Chrome must not require <all_urls>; it is intentionally an optional permission.');
}
if (!(chrome.manifest.optional_host_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Chrome optional host permission is missing.');
}

if (firefox.manifest.manifest_version !== 2 || !firefox.manifest.background?.scripts?.includes('background.js')) {
  throw new Error(`Invalid Firefox MV2 background manifest: ${firefox.manifestPath}`);
}
if (firefox.manifest.browser_action?.default_popup !== 'popup.html') {
  throw new Error(`Firefox popup is missing from ${firefox.manifestPath}`);
}
if ((firefox.manifest.permissions ?? []).includes('<all_urls>')) {
  throw new Error('Firefox must not require <all_urls>; it is intentionally an optional permission.');
}
if (!(firefox.manifest.optional_permissions ?? []).includes('<all_urls>')) {
  throw new Error('Firefox optional host permission is missing.');
}
if (firefox.manifest.browser_specific_settings?.gecko?.id !== 'frametrail@local') {
  throw new Error('Firefox add-on ID is missing or unexpected.');
}

for (const build of [chrome, firefox]) {
  await requireFiles(build, [
    'background.js',
    'popup.html',
    'editor.html',
    'library.html',
    'practice.html',
    'snapshot-shield.html',
    'content-scripts/content.js',
  ]);
}

console.log('Chrome MV3 and Firefox MV2 artifacts are structurally valid.');
