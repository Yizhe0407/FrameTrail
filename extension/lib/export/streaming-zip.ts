import { Zip, ZipPassThrough } from 'fflate';

/** Adds one fully-buffered, stored (uncompressed) file to the archive. */
export type ZipFileWriter = (filename: string, bytes: Uint8Array) => void;

/**
 * Streams files into an in-memory ZIP and resolves with the finished Blob.
 *
 * The builder receives an `addFile` writer and controls ordering; the archive
 * is ended automatically when the builder returns. On any failure — the
 * builder throwing (including aborts) or fflate reporting a stream error —
 * the archive is terminated and the stream promise is observed, so no error
 * path can leak an unhandled rejection or a live deflate stream.
 */
export async function buildZipBlob(build: (addFile: ZipFileWriter) => Promise<void> | void): Promise<Blob> {
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
    // fflate may reuse its output buffer after this callback. Keep one owned
    // copy per emitted chunk, but avoid a final contiguous copy that would
    // temporarily double the entire archive in memory.
    const owned = new Uint8Array(chunk.byteLength);
    owned.set(chunk);
    chunks.push(owned.buffer);
    if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
  });

  const addFile: ZipFileWriter = (filename, bytes) => {
    const file = new ZipPassThrough(filename);
    archive.add(file);
    file.push(bytes, true);
  };

  try {
    await build(addFile);
    archive.end();
    // Awaiting inside the try folds a late fflate error into the same
    // terminate-and-rethrow path as a builder failure.
    return await result;
  } catch (error) {
    archive.terminate();
    // The stream promise may reject after (or instead of) the builder error;
    // observe it so the losing rejection is never reported as unhandled.
    result.catch(() => {});
    throw error;
  }
}

/**
 * Zero-padded ordinal for ZIP image filenames. Padding is always at least two
 * digits so exports sort correctly even for guides with fewer than ten steps.
 */
export function paddedZipOrdinal(ordinal: number, entryCount: number): string {
  return String(ordinal).padStart(Math.max(2, String(entryCount).length), '0');
}
