/**
 * Chromium can resolve runtime.sendMessage() with null/undefined when the
 * receiving extension context disappeared before it produced a response (for
 * example during an extension reload or a tab navigation). Keep that transport
 * failure at the boundary instead of letting callers crash while reading `.ok`.
 */
export function requireRuntimeMessageResult<T extends { ok: boolean }>(
  value: unknown,
  unavailableMessage = 'FrameTrail 背景服務暫時無法回應，請重新整理頁面後再試一次。',
): T {
  if (
    value == null ||
    typeof value !== 'object' ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error(unavailableMessage);
  }
  return value as T;
}
