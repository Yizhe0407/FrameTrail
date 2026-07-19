import { expect, type Frame, type Page } from '@playwright/test';

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      clear(): Promise<void>;
      get(key: string): Promise<Record<string, { isRecording?: boolean } | undefined>>;
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
    const state = await chrome.storage.local.get('scribe:recordingState');
    if (state['scribe:recordingState']?.isRecording) {
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('scribe', 3);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('steps', 'readwrite');
        tx.objectStore('steps').clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    await chrome.storage.local.clear();
  });
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
      const request = indexedDB.open('scribe', 3);
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

export async function rawScreenshotRosePixels(popup: Page, stepId: string): Promise<number> {
  return popup.evaluate(async (id) => {
    return await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('scribe', 3);
      request.onerror = () => reject(request.error);
      request.onsuccess = async () => {
        const db = request.result;
        const all = db.transaction('steps', 'readonly').objectStore('steps').getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = async () => {
          const step = all.result.find((candidate) => candidate.id === id);
          if (!step?.screenshotBlob || !step.bounds) {
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
          const left = Math.max(0, Math.floor((step.bounds.x - 10) * scale));
          const top = Math.max(0, Math.floor((step.bounds.y - 10) * scale));
          const right = Math.min(canvas.width, Math.ceil((step.bounds.x + step.bounds.width + 10) * scale));
          const bottom = Math.min(canvas.height, Math.ceil((step.bounds.y + step.bounds.height + 10) * scale));
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
  }, stepId);
}

export async function startRecording(appPage: Page, popup: Page, mode: RecordingMode, numbered = true): Promise<void> {
  await appPage.bringToFront();
  await popup.evaluate(async ({ mode, numbered }) => {
    await chrome.runtime.sendMessage({ type: 'START_RECORDING', mode, numbered });
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
