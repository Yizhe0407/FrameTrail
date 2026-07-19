import { access, cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromeBuildPath, preparedExtensionPath } from '../support/paths';

export default async function globalSetup(): Promise<void> {
  const sourceManifest = path.join(chromeBuildPath, 'manifest.json');
  try {
    await access(sourceManifest);
  } catch {
    throw new Error('Chrome production build is missing. Run `pnpm build` before Playwright.');
  }

  await rm(preparedExtensionPath, { recursive: true, force: true });
  await cp(chromeBuildPath, preparedExtensionPath, { recursive: true });

  const manifestPath = path.join(preparedExtensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    permissions?: string[];
    host_permissions?: string[];
    optional_host_permissions?: string[];
  };
  // Production only needs clipboardWrite. The isolated E2E copy also reads
  // the clipboard so tests can verify the PNG bytes that the UI wrote.
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), 'clipboardRead'])];
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), '<all_urls>'])];
  manifest.optional_host_permissions = (manifest.optional_host_permissions ?? []).filter(
    (permission) => permission !== '<all_urls>',
  );
  if (manifest.optional_host_permissions.length === 0) delete manifest.optional_host_permissions;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
