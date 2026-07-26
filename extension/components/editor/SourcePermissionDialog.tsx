import { AlertCircle, ExternalLink, Loader2, ShieldCheck, Video, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import ContinuationTabPicker from '@/components/editor/ContinuationTabPicker';
import type { ContinuationTabOption } from '@/lib/editor/editor-app-model';

interface Props {
  open: boolean;
  /** Origin the browser prompt will name. Shown verbatim so the user can compare
   * it against the permission prompt Chrome raises next. */
  sourceOrigin: string;
  /** What the grant is for, e.g. 補拍 or 接續錄製. */
  actionLabel: string;
  pending?: boolean;
  /** Continuation only: opens the explicit 「改在其他頁面接續」 tab picker,
   * which records a user-chosen normal tab without a source grant. */
  onContinueElsewhere?: () => void;
  continueElsewherePending?: boolean;
  continueElsewhereError?: string | null;
  /** Non-null once the elsewhere picker is open: the recordable tabs to choose
   * from, most recently used first. */
  continuationTabs?: ContinuationTabOption[] | null;
  selectedContinuationTabId?: number | null;
  onSelectContinuationTab?: (tabId: number) => void;
  /** Confirms the picked tab and starts recording there. */
  onConfirmContinueElsewhere?: () => void;
  /** When set, the Guide has no stored source page: the source-locked confirm
   * is hidden and only the elsewhere path remains, with this reason shown. */
  sourceUnavailableReason?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Granting a host permission is a security decision, so it gets a modal rather
 * than a banner: it states the exact origin, blocks the editor behind it, and
 * cannot scroll out of view while the browser's own prompt is about to appear.
 *
 * The confirm button must remain the direct source of the click that calls
 * browser.permissions.request — Chromium only honours the request while
 * transient user activation from that gesture is alive.
 *
 * The 改在其他頁面接續 path is two-step: the first click swaps this dialog's
 * body for an explicit tab picker (no auto-guessing a target), and the second
 * confirms the picked tab and starts a plain recording there.
 */
export default function SourcePermissionDialog({
  open,
  sourceOrigin,
  actionLabel,
  pending = false,
  onContinueElsewhere,
  continueElsewherePending = false,
  continueElsewhereError = null,
  continuationTabs = null,
  selectedContinuationTabId = null,
  onSelectContinuationTab,
  onConfirmContinueElsewhere,
  sourceUnavailableReason = null,
  onCancel,
  onConfirm,
}: Props) {
  const anyPending = pending || continueElsewherePending;
  const sourceUnavailable = sourceUnavailableReason !== null;
  const pickerOpen = continuationTabs !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !anyPending) onCancel(); }}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => anyPending && event.preventDefault()}
        onPointerDownOutside={(event) => anyPending && event.preventDefault()}
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-border bg-card p-6 text-foreground"
      >
        <DialogHeader className="pr-2">
          <DialogTitle className="flex items-center gap-2">
            {pickerOpen || sourceUnavailable ? (
              <Video className="size-4 text-brand" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-4 text-brand" aria-hidden="true" />
            )}
            {pickerOpen ? '選擇要接續錄製的分頁' : sourceUnavailable ? actionLabel : `${actionLabel}前需要存取來源網站`}
          </DialogTitle>
          <DialogDescription className="leading-6 text-muted-foreground">
            {pickerOpen
              ? '錄製會從選取的分頁開始，之後會跟著你切換的分頁；新步驟會接在最後。'
              : sourceUnavailable
                ? `${sourceUnavailableReason}你可以改在目前開啟的網頁分頁繼續錄製。`
                : 'FrameTrail 只會要求這個網站的存取權，且會在開始前由背景程序再次核對目前儲存的來源。'}
          </DialogDescription>
        </DialogHeader>

        {!pickerOpen && !sourceUnavailable && (
          <p className="mt-4 rounded-md border border-border bg-secondary px-3 py-2.5 font-mono text-xs break-all text-foreground">
            {sourceOrigin}
          </p>
        )}

        {pickerOpen && onSelectContinuationTab && (
          <ContinuationTabPicker
            tabs={continuationTabs}
            selectedTabId={selectedContinuationTabId}
            onSelect={onSelectContinuationTab}
            disabled={anyPending}
          />
        )}

        {!pickerOpen && onContinueElsewhere && (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">新步驟會接在最後。</p>
        )}

        {continueElsewhereError && (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-[18px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{continueElsewhereError}</span>
          </p>
        )}

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={anyPending} onClick={onCancel}>
            <X />取消
          </Button>
          {pickerOpen ? (
            <Button
              type="button"
              disabled={anyPending || selectedContinuationTabId === null}
              onClick={onConfirmContinueElsewhere}
            >
              {continueElsewherePending ? <Loader2 className="animate-spin" /> : <Video />}
              開始錄製
            </Button>
          ) : (
            <>
              {onContinueElsewhere && (
                <Button
                  type="button"
                  variant={sourceUnavailable ? 'default' : 'outline'}
                  disabled={anyPending}
                  onClick={onContinueElsewhere}
                >
                  {continueElsewherePending ? <Loader2 className="animate-spin" /> : <ExternalLink />}
                  改在其他頁面接續
                </Button>
              )}
              {!sourceUnavailable && (
                <Button type="button" disabled={anyPending} onClick={onConfirm}>
                  {pending && <Loader2 className="animate-spin" />}
                  {pending ? '正在授權…' : '允許並開始'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
