import { expect, type Frame, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      clear(): Promise<void>;
      get(key: 'scribe:recordingState'): Promise<Record<string, { isRecording?: boolean } | undefined>>;
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  downloads: {
    search(query: { orderBy?: string[]; limit?: number }): Promise<Array<{
      filename: string;
      mime?: string;
      state: string;
    }>>;
  };
};

export type RecordingMode = 'steps' | 'snapshot';

function decodePngRgba(input: Buffer): { width: number; height: number; channels: number; pixels: Uint8Array } {
  if (input.readUInt32BE(0) !== 0x89504e47 || input.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Expected a PNG screenshot.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('Only 8-bit RGB/RGBA PNG screenshots are supported.');
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++];
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      pixels[rowStart + x] = (raw[source++] + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export async function readRootScrollbarSentinelPixels(page: Page): Promise<number> {
  const decoded = decodePngRgba(await page.screenshot({ type: 'png' }));
  const stripWidth = Math.min(24, decoded.width);
  let count = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = decoded.width - stripWidth; x < decoded.width; x += 1) {
      const index = (y * decoded.width + x) * decoded.channels;
      const red = decoded.pixels[index];
      const green = decoded.pixels[index + 1];
      const blue = decoded.pixels[index + 2];
      if (
        (red > 170 && green < 100 && blue > 170) ||
        (red < 100 && green > 170 && blue < 100) ||
        (red < 100 && green > 170 && blue > 170) ||
        (red > 170 && green > 170 && blue < 100)
      ) count += 1;
    }
  }
  return count;
}

export interface StoredStep {
  id: string;
  sessionId: string;
  order: number;
  description: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  groupId?: string;
  numbered?: boolean;
  screenshotScale?: number;
  devicePixelRatio: number;
  hasScreenshot: boolean;
}

export async function resetExtensionData(popup: Page): Promise<void> {
  await popup.evaluate(async () => {
    const guideId = crypto.randomUUID();
    const state = await chrome.storage.local.get('scribe:recordingState');
    if (state['scribe:recordingState']?.isRecording) {
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('scribe', 4);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('FrameTrail IndexedDB reset was blocked.'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('steps')) {
          const steps = db.createObjectStore('steps', { keyPath: 'id' });
          steps.createIndex('by-session', 'sessionId');
        }
        if (!db.objectStoreNames.contains('guides')) {
          const guides = db.createObjectStore('guides', { keyPath: 'id' });
          guides.createIndex('by-updated-at', 'updatedAt');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const storeNames = ['guides', 'steps'].filter((name) => db.objectStoreNames.contains(name));
        if (storeNames.length !== 2) {
          db.close();
          reject(new Error('FrameTrail IndexedDB v4 stores are incomplete.'));
          return;
        }
        const tx = db.transaction(storeNames, 'readwrite');
        for (const storeName of storeNames) tx.objectStore(storeName).clear();
        tx.objectStore('guides').add({
          id: guideId,
          title: 'E2E 測試教學',
          description: '',
          sections: [],
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
          contentRevision: 0,
          stepCount: 0,
          entryCount: 0,
          storageBytes: 0,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Reset transaction was aborted.'));
      };
    });
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      'frametrail:onboarding:v1': { version: 1, completed: true, completedAt: 0 },
      'frametrail:activeGuideId': guideId,
    });
  });
  await popup.reload({ waitUntil: 'domcontentloaded' });
}

export async function readRecordingState(popup: Page): Promise<Record<string, unknown>> {
  return popup.evaluate(async () => {
    const result = await chrome.storage.local.get('scribe:recordingState');
    return (result['scribe:recordingState'] ?? {}) as Record<string, unknown>;
  });
}

export async function readSteps(popup: Page): Promise<StoredStep[]> {
  return popup.evaluate(async () => {
    return await new Promise<StoredStep[]>((resolve, reject) => {
      const request = indexedDB.open('scribe', 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          resolve(
            all.result.map((step) => ({
              id: step.id,
              sessionId: step.sessionId,
              order: step.order,
              description: step.description,
              bounds: step.bounds,
              groupId: step.groupId,
              numbered: step.numbered,
              screenshotScale: step.screenshotScale,
              devicePixelRatio: step.devicePixelRatio,
              hasScreenshot: step.screenshotBlob instanceof Blob,
            })).sort((first, second) => first.order - second.order),
          );
          db.close();
        };
      };
    });
  });
}

export async function readLatestDownload(popup: Page): Promise<{
  filename: string;
  mime?: string;
  state: string;
} | null> {
  return popup.evaluate(async () => {
    const [download] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    return download ?? null;
  });
}

export async function rawScreenshotRosePixels(
  popup: Page,
  stepId: string,
  boundsOverride?: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return popup.evaluate(async ({ id, boundsOverride }) => {
    return await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('scribe', 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = async () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = async () => {
          const step = all.result.find((candidate) => candidate.id === id);
          const sampleBounds = boundsOverride ?? step?.bounds;
          if (!step?.screenshotBlob || !sampleBounds) {
            db.close();
            reject(new Error(`Screenshot ${id} was not found`));
            return;
          }
          const bitmap = await createImageBitmap(step.screenshotBlob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas context is unavailable');
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const scale = step.screenshotScale || step.devicePixelRatio || 1;
          const left = Math.max(0, Math.floor((sampleBounds.x - 10) * scale));
          const top = Math.max(0, Math.floor((sampleBounds.y - 10) * scale));
          const right = Math.min(canvas.width, Math.ceil((sampleBounds.x + sampleBounds.width + 10) * scale));
          const bottom = Math.min(canvas.height, Math.ceil((sampleBounds.y + sampleBounds.height + 10) * scale));
          const pixels = context.getImageData(left, top, right - left, bottom - top).data;
          let rosePixels = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            if (red > 180 && red - green > 60 && red - blue > 20) rosePixels++;
          }
          db.close();
          resolve(rosePixels);
        };
      };
    });
  }, { id: stepId, boundsOverride });
}

export async function readScreenshotScrollbarStats(popup: Page, stepId: string): Promise<{
  width: number;
  height: number;
  rootSentinelPixels: number;
  nestedSentinelPixels: number;
}> {
  return popup.evaluate(async (id) => {
    return await new Promise<{
      width: number;
      height: number;
      rootSentinelPixels: number;
      nestedSentinelPixels: number;
    }>((resolve, reject) => {
      const request = indexedDB.open('scribe', 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = async () => {
          try {
            const step = all.result.find((candidate) => candidate.id === id);
            if (!step?.screenshotBlob) throw new Error(`Screenshot ${id} was not found`);
            const bitmap = await createImageBitmap(step.screenshotBlob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas context is unavailable');
            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const rootStripWidth = Math.min(24, bitmap.width);
            let rootSentinelPixels = 0;
            let nestedSentinelPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              const red = pixels[index];
              const green = pixels[index + 1];
              const blue = pixels[index + 2];
              const x = (index / 4) % bitmap.width;
              const magenta = red > 170 && green < 100 && blue > 170;
              const greenTrack = red < 100 && green > 170 && blue < 100;
              const cyanButton = red < 100 && green > 170 && blue > 170;
              const yellowCorner = red > 170 && green > 170 && blue < 100;
              if (
                x >= bitmap.width - rootStripWidth &&
                (magenta || greenTrack || cyanButton || yellowCorner)
              ) {
                rootSentinelPixels++;
              }
              const orangeThumb = red > 180 && green > 50 && green < 170 && blue < 80;
              const blueTrack = red < 80 && green > 50 && green < 160 && blue > 180;
              if (orangeThumb || blueTrack) nestedSentinelPixels++;
            }
            const result = { width: bitmap.width, height: bitmap.height, rootSentinelPixels, nestedSentinelPixels };
            bitmap.close();
            resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            db.close();
          }
        };
      };
    });
  }, stepId);
}

export async function startRecording(appPage: Page, popup: Page, mode: RecordingMode, numbered = true): Promise<void> {
  await appPage.bringToFront();
  await popup.evaluate(async ({ mode, numbered }) => {
    try {
      const stored = await chrome.storage.local.get('frametrail:activeGuideId');
      const sessionId = stored['frametrail:activeGuideId'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('No active E2E Guide was initialized.');
      }
      const result = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        sessionId,
        mode,
        numbered,
      }) as { ok: true } | { ok: false; error?: string } | undefined;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'START_RECORDING failed without a typed result');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `START_RECORDING rejected: ${error.message}`
          : `START_RECORDING rejected: ${String(error)}`,
      );
    }
  }, { mode, numbered });
  await expect.poll(async () => (await readRecordingState(popup)).isRecording).toBe(true);
  if (mode === 'steps') {
    await expect.poll(() => appPage.locator('[data-frametrail-step-preview]').count()).toBe(1);
  } else {
    await expect.poll(() => appPage.locator('[data-frametrail-snapshot-shield]').count()).toBe(1);
    await getSnapshotFrame(appPage);
  }
}

export async function stopRecording(popup: Page): Promise<void> {
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  });
  await expect.poll(async () => (await readRecordingState(popup)).isRecording).toBe(false);
}

export async function sendRecordingControl(
  page: Page,
  type: string,
  undoToken?: string,
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async ({ type, undoToken }) => {
    const result = await chrome.storage.local.get('scribe:recordingState');
    const runId = (result['scribe:recordingState'] as { runId?: string } | undefined)?.runId;
    return chrome.runtime.sendMessage({ type, runId, ...(undoToken ? { undoToken } : {}) }) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }, { type, undoToken });
}

export async function hoverTarget(page: Page, locator: Parameters<Page['locator']>[0]): Promise<void> {
  const target = page.locator(locator);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Target ${locator} has no bounding box`);
  await page.mouse.move(5, 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(160);
}

export async function clickTarget(page: Page, locator: Parameters<Page['locator']>[0]): Promise<void> {
  const point = await targetCenter(page, locator);
  await page.mouse.click(point.x, point.y);
}

export async function targetCenter(
  page: Page,
  locator: Parameters<Page['locator']>[0],
): Promise<{ x: number; y: number }> {
  const box = await page.locator(locator).boundingBox();
  if (!box) throw new Error(`Target ${locator} has no bounding box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function getSnapshotFrame(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const frame = page.frames().find((candidate) => candidate.url().includes('snapshot-shield.html'));
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error('Snapshot shield frame did not become available');
}

export async function clickSnapshotTarget(page: Page, point: { x: number; y: number }): Promise<void> {
  const frame = await getSnapshotFrame(page);
  await frame.locator('body').click({ position: point });
}

export async function getStepPreviewStyle(page: Page): Promise<{ hidden: boolean; style: string | null }> {
  const client = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = (node: { attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[]; contentDocument?: unknown }, predicate: (value: typeof node) => boolean): typeof node | null => {
    if (predicate(node)) return node;
    for (const collection of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : undefined]) {
      for (const child of collection ?? []) {
        const found = find(child as typeof node, predicate);
        if (found) return found;
      }
    }
    return null;
  };
  const preview = find(root, (node) => {
    const attributes = node.attributes ?? [];
    const classIndex = attributes.indexOf('class');
    return classIndex >= 0 && attributes[classIndex + 1]?.split(/\s+/).includes('preview');
  });
  await client.detach();
  if (!preview) return { hidden: true, style: null };
  const attributes = preview.attributes ?? [];
  const styleIndex = attributes.indexOf('style');
  const style = styleIndex >= 0 ? attributes[styleIndex + 1] : null;
  return { hidden: style?.includes('display: none') ?? true, style };
}
