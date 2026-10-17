import { useLayoutEffect, useState } from 'react';

interface CachedObjectUrl {
  url: string;
  consumers: number;
}

const cache = new WeakMap<Blob, CachedObjectUrl>();

/** Shares one object URL for every mounted consumer of the same immutable
 * Blob. This avoids duplicate browser decodes across rail, stage, and
 * lightbox while revoking the URL as soon as its final consumer unmounts.
 * A null Blob has no URL, and a URL is only ever returned for the Blob it was
 * made from: right after the Blob changes, the previous one's URL is not. */
export function useObjectUrl(blob: Blob | null): string {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);

  useLayoutEffect(() => {
    if (!blob) {
      setCurrent(null);
      return undefined;
    }
    let cached = cache.get(blob);
    if (!cached) {
      cached = { url: URL.createObjectURL(blob), consumers: 0 };
      cache.set(blob, cached);
    }
    cached.consumers++;
    setCurrent({ blob, url: cached.url });

    return () => {
      cached.consumers--;
      if (cached.consumers === 0) {
        URL.revokeObjectURL(cached.url);
        cache.delete(blob);
      }
    };
  }, [blob]);

  return current && current.blob === blob ? current.url : '';
}
