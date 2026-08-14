import { browser, type Browser } from 'wxt/browser';
import { isTrustedEditorSenderForSession } from '../../capture/recapture-guards';
import { getSteps } from '../../storage/step-repository';
import { isRestrictedUrl } from '../../shared/restricted-urls';
import { waitForTabComplete } from '../../runtime/tab-loading';
import type { SourcePermissionPreflightSuccess, StartRecordingMessage } from '../../runtime/messages';

// Shared with the recapture flow and the continuation preflight, so the
// wording of the two source-tab failure modes cannot drift apart.
export const SOURCE_TAB_OPEN_FAILED_MESSAGE = '無法開啟原始頁面。';
export const RESTRICTED_CONTINUATION_SOURCE_MESSAGE = '此來源頁面不允許錄製。';
export const EDITOR_ONLY_CONTINUATION_MESSAGE = '只能從目前 Guide 的 FrameTrail 編輯器接續錄製。';
const CONTINUATION_SOURCE_REDIRECTED_MESSAGE = '原始頁面已重新導向，未開始錄製。';

export type SourceTabAcquisition = { tab: Browser.tabs.Tab; reused: boolean };

/** Binds an editor sender to the session it may act on. Lives here because the
 * source-tab flows are exactly the operations an editor page nominates. */
export function isEditorSenderForSession(sender: Browser.runtime.MessageSender, sessionId: string): boolean {
  return isTrustedEditorSenderForSession(sender, browser.runtime.getURL('/editor.html'), sessionId);
}

function recapturePermissionPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

export function sourcePermissionPreflightSuccess(sourceUrl: string): SourcePermissionPreflightSuccess | null {
  const permissionPattern = recapturePermissionPattern(sourceUrl);
  if (!permissionPattern || isRestrictedUrl(sourceUrl)) return null;
  return {
    ok: true,
    sourceUrl,
    sourceOrigin: new URL(sourceUrl).origin,
    permissionPattern,
  };
}

/** The permission preflight recapture and continuation share: the source must
 * be a permissible http(s) URL outside the restricted list whose host
 * permission is already granted — start flows never prompt (the editor's
 * preflight owns the prompt). */
export async function checkSourcePermission(
  sourceUrl: string,
): Promise<'restricted' | 'permission-required' | 'granted'> {
  const preflight = sourcePermissionPreflightSuccess(sourceUrl);
  if (!preflight) return 'restricted';
  return (await browser.permissions.contains({ origins: [preflight.permissionPattern] }))
    ? 'granted'
    : 'permission-required';
}

async function findOrCreateSourceTab(
  sourceUrl: string,
  preferredTabId?: number,
): Promise<SourceTabAcquisition> {
  if (preferredTabId != null) {
    try {
      const preferred = await browser.tabs.get(preferredTabId);
      if (preferred.id != null && preferred.url === sourceUrl) {
        return { tab: await waitForTabComplete(preferred.id), reused: true };
      }
    } catch {
      // The nominated tab disappeared; fall through to another exact match.
    }
  }
  const tabs = await browser.tabs.query({});
  const exact = tabs.find((tab) => tab.id != null && tab.url === sourceUrl);
  if (exact?.id != null) return { tab: await waitForTabComplete(exact.id), reused: true };
  const created = await browser.tabs.create({ url: sourceUrl, active: false });
  if (created.id == null) throw new Error('Browser did not create a source tab.');
  try {
    return { tab: await waitForTabComplete(created.id), reused: false };
  } catch (error) {
    // Nothing owns this tab yet (no persisted state references it), so a load
    // timeout or removal race must close it here or every attempt leaks a tab.
    await browser.tabs.remove(created.id).catch((cleanupError) => {
      console.warn('[frametrail] failed to close an unloaded source tab', cleanupError);
    });
    throw error;
  }
}

/**
 * Closes a tab findOrCreateSourceTab created while no persisted state owns it
 * yet. Every failure path between creation and the state write that records
 * sourceTabCreated must call this, or each failed attempt leaks a stray tab —
 * prefer withUncommittedSourceTab, which makes the obligation structural.
 */
async function discardUncommittedSourceTab(source: SourceTabAcquisition): Promise<void> {
  if (source.reused || source.tab.id == null) return;
  await browser.tabs.remove(source.tab.id).catch((error) => {
    console.warn('[frametrail] failed to close an unused source tab', error);
  });
}

/**
 * Opens (or reuses) the exact-URL source tab and verifies it still shows that
 * URL after loading. On 'redirected' any tab this call created has already
 * been closed; 'open-failed' has already been logged under `logLabel`.
 */
export async function openVerifiedSourceTab(
  sourceUrl: string,
  preferredTabId: number | undefined,
  logLabel: string,
): Promise<
  | { ok: true; source: SourceTabAcquisition }
  | { ok: false; reason: 'open-failed' | 'redirected' }
> {
  let source: SourceTabAcquisition;
  try {
    source = await findOrCreateSourceTab(sourceUrl, preferredTabId);
  } catch (error) {
    console.error(`[frametrail] ${logLabel}`, error);
    return { ok: false, reason: 'open-failed' };
  }
  if (source.tab.id == null || source.tab.url !== sourceUrl) {
    await discardUncommittedSourceTab(source);
    return { ok: false, reason: 'redirected' };
  }
  return { ok: true, source };
}

/**
 * Scope helper for the window between acquiring a source tab and the state
 * write that records its ownership: `fn` receives `commit` and must call it
 * once persisted state owns the tab — every other exit (early failure return
 * or a throw) closes a tab this acquisition created. This turns the per-site
 * cleanup convention into a structural guarantee.
 */
export async function withUncommittedSourceTab<T>(
  source: SourceTabAcquisition,
  fn: (commit: () => void) => Promise<T>,
): Promise<T> {
  let committed = false;
  try {
    return await fn(() => {
      committed = true;
    });
  } finally {
    if (!committed) await discardUncommittedSourceTab(source);
  }
}

/** Where a continuation run resumes: the persisted URL of the Guide's last
 * step. Editors never supply this — a caller-provided URL would let an editor
 * page nominate an arbitrary origin for the permission prompt. */
export async function resolveGuideContinuationSourceUrl(sessionId: string): Promise<string | null> {
  const steps = await getSteps(sessionId);
  return steps.length > 0 ? steps[steps.length - 1].url : null;
}

/**
 * Continuation resolves its own target tab because the editor page cannot be
 * recorded and holds no activeTab grant over the source site. Every precondition
 * recapture enforces applies here too: trusted editor, persisted source URL, an
 * explicit host permission, and an exact-URL tab.
 */
export async function resolveContinuationTab(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
): Promise<{ ok: true; tab: Browser.tabs.Tab } | { ok: false; error: string }> {
  if (!isEditorSenderForSession(sender, message.sessionId)) {
    return { ok: false, error: EDITOR_ONLY_CONTINUATION_MESSAGE };
  }
  const sourceUrl = await resolveGuideContinuationSourceUrl(message.sessionId);
  if (!sourceUrl) {
    return { ok: false, error: '這份內容還沒有可接續的來源頁面，請從彈出視窗開始新的錄製。' };
  }
  const permission = await checkSourcePermission(sourceUrl);
  if (permission === 'restricted') {
    return { ok: false, error: RESTRICTED_CONTINUATION_SOURCE_MESSAGE };
  }
  if (permission === 'permission-required') {
    return { ok: false, error: '需要先允許 FrameTrail 存取此網站，才能接續錄製。' };
  }
  const opened = await openVerifiedSourceTab(
    sourceUrl,
    message.continuation?.preferredTabId,
    'failed to open continuation source tab',
  );
  if (!opened.ok) {
    return {
      ok: false,
      error: opened.reason === 'open-failed' ? SOURCE_TAB_OPEN_FAILED_MESSAGE : CONTINUATION_SOURCE_REDIRECTED_MESSAGE,
    };
  }
  return { ok: true, tab: opened.source.tab };
}
