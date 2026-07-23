/** Public project-archive compatibility facade. Schema, validation and codecs
 * are intentionally separate so browser-facing callers retain one stable import. */
export {
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LEGACY_VERSION,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_MIME_TYPE,
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveError,
  type ImportedProjectArchive,
  type ProjectArchiveErrorCode,
  type ProjectArchiveImportOptions,
  type ProjectArchiveImportWithMetadataOptions,
  type ProjectArchiveMetadata,
  type ProjectArchiveMetadataInput,
  type ProjectArchiveOptions,
  type ProjectArchiveSource,
} from './project-archive-contract';
export { exportProjectArchive, serializeProjectArchive } from './project-archive-serialize';
export { importProjectArchive } from './project-archive-import';

import { exportProjectArchive } from './project-archive-serialize';
import { importProjectArchive } from './project-archive-import';

/** Naming aliases for callers that prefer create/parse terminology. */
export const createProjectArchive = exportProjectArchive;
export const parseProjectArchive = importProjectArchive;
