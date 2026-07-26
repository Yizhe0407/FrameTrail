import { Zip, ZipPassThrough } from 'fflate';

/** Adds one fully-buffered, stored (uncompressed) file to the archive. The
 * archive takes ownership of `bytes`: the caller must not mutate the array
 * afterwards (the bytes are referenced, not copied, until the Blob is built). */
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
  const chunks: BlobPart[] = [];
  // Arrays handed to addFile. ZipPassThrough forwards each one through to the
  // output callback unchanged, so they can be retained as-is (addFile's
  // documented ownership transfer) instead of copied.
  const callerOwned = new Set<Uint8Array>();
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
    if (callerOwned.delete(chunk)) {
      // File data we already own: retaining the view avoids duplicating every
      // image in memory for the lifetime of the chunk list.
      chunks.push(chunk as Uint8Array<ArrayBuffer>);
    } else {
      // Chunks fflate generated itself (headers, data descriptors, central
      // directory). Defensively keep one owned copy in case fflate ever
      // reuses an output buffer, but avoid a final contiguous copy that
      // would temporarily double the entire archive in memory.
      const owned = new Uint8Array(chunk.byteLength);
      owned.set(chunk);
      chunks.push(owned);
    }
    if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
  });

  const addFile: ZipFileWriter = (filename, bytes) => {
    const file = new ZipPassThrough(filename);
    archive.add(file);
    callerOwned.add(bytes);
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
