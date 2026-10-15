import { exportProjectArchive } from '../export/project-archive-serialize';
import { getProjectSummaries } from '../storage/project-repository';
import { getSteps } from '../storage/step-repository';
import type { ProjectSummary } from '../storage/models';
import { queryBackupPermission } from './directory-handle';
import { runBackup, type BackupResult } from './backup-runner';
import {
  getBackupConfig,
  getBackupManifest,
  putBackupManifestEntry,
  saveBackupLastRun,
} from './backup-store';

const LOCK_NAME = 'stepmark-folder-backup';

async function buildArchive(project: ProjectSummary): Promise<Blob> {
  return exportProjectArchive(await getSteps(project.id), {
    metadata: {
      title: project.title,
      description: project.description,
      sections: project.sections,
      tags: project.tags,
    },
  });
}

/** Whether a backup could run right now without asking the user for anything. */
export type BackupAvailability = 'off' | 'needs-permission' | 'ready';

export async function getBackupAvailability(): Promise<BackupAvailability> {
  const config = await getBackupConfig();
  if (!config) return 'off';
  return (await queryBackupPermission(config.directory)) === 'granted' ? 'ready' : 'needs-permission';
}

/**
 * Backs up changed projects to the chosen folder if (and only if) it is
 * already writable. Safe to call from every open page: a Web Lock makes
 * overlapping calls (library and editor both open) a no-op instead of two
 * writers racing on the same files. Returns null when nothing ran.
 */
export async function runFolderBackup(): Promise<BackupResult | null> {
  const config = await getBackupConfig();
  if (!config || (await queryBackupPermission(config.directory)) !== 'granted') return null;

  const run = async (): Promise<BackupResult> => {
    const result = await runBackup({
      directory: config.directory,
      listProjects: getProjectSummaries,
      buildArchive,
      getManifest: getBackupManifest,
      putManifestEntry: putBackupManifestEntry,
    });
    await saveBackupLastRun({ at: Date.now(), written: result.written, failed: result.failed, error: result.error });
    return result;
  };

  if (typeof navigator === 'undefined' || !navigator.locks) return run();
  return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? run() : null));
}
