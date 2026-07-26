export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MIN_CAPTURE_INTERVAL_MS = 500;
let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();
export function queueCapture<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    return task();
  };
  const result = captureChain.then(run, run);
  captureChain = result.then(() => undefined, () => undefined);
  return result;
}

function serializedQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const result = chain.then(task, task);
      chain = result.then(() => undefined, () => undefined);
      return result;
    },
    wait(): Promise<void> {
      return chain.then(() => undefined);
    },
  };
}

/** Click, lifecycle and persisted-state writes have deliberately independent
 * queues; callers place barriers explicitly where their transaction needs it. */
const clickQueue = serializedQueue();
const lifecycleQueue = serializedQueue();
const stateMutationQueue = serializedQueue();
export const queueClick = clickQueue.enqueue;
export const queueLifecycle = lifecycleQueue.enqueue;
export const queueStateMutation = stateMutationQueue.enqueue;
export const waitForQueuedClicks = () => clickQueue.wait();

export class StaleCaptureError extends Error {}
