import { useLayoutEffect, useState } from 'react';

interface CachedObjectUrl {
  url: string;
  consumers: number;
}

const cache = new WeakMap<Blob, CachedObjectUrl>();

/** Shares one object URL for every mounted consumer of the same immutable
 * Blob. This avoids duplicate browser decodes across rail, stage, and
 * lightbox while revoking the URL as soon as its final consumer unmounts. */
export function useObjectUrl(blob: Blob): string {
  const [url, setUrl] = useState('');

  useLayoutEffect(() => {
    let cached = cache.get(blob);
    if (!cached) {
      cached = { url: URL.createObjectURL(blob), consumers: 0 };
      cache.set(blob, cached);
    }
    cached.consumers++;
    setUrl(cached.url);

    return () => {
      cached.consumers--;
      if (cached.consumers === 0) {
        URL.revokeObjectURL(cached.url);
        cache.delete(blob);
      }
    };
  }, [blob]);

  return url;
}
