import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Copy,
  Download,
  Filter,
  Loader2,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { createGuideFromSteps, deleteGuidePermanently, duplicateGuide, getGuideSummaries, updateGuide } from '@/lib/storage/guide-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { type GuideSummary } from '@/lib/storage/models';
import { clearSelectedGuide, createAndSelectGuide, openSelectedGuideInEditor } from '@/lib/guide/guide-actions';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { cn } from '@/lib/shared/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AppToaster from '@/components/shared/AppToaster';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import { reportError } from '@/components/shared/report-error';
import { usePendingAction } from '@/components/shared/use-pending-action';
import { UNTITLED_GUIDE_TITLE } from '@/lib/editor/editor-messages';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { importProjectArchive } from '@/lib/export/project-archive-import';
import { PROJECT_ARCHIVE_LIMITS } from '@/lib/export/project-archive-contract';
import { guideExportFilename } from '@/lib/export/guide-export-contract';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

/** Derives the .frametrail archive name from the same stem the publication
 * exporters use, so the library and editor name files identically. The stem
 * helper itself is not exported, so strip the extension the facade appends. */
function exportFilename(title: string): string {
  const stem = guideExportFilename({ title }, 'html').replace(/\.html$/, '');
  return `${stem}.frametrail`;
}

export default function App() {
  const [guides, setGuides] = useState<GuideSummary[]>([]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const { pendingKey: pendingId, runExclusive } = usePendingAction<string>();
  const [deleteTarget, setDeleteTarget] = useState<GuideSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<GuideSummary | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationLocked, setOperationLocked] = useState(false);

  async function refresh(options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    try {
      const [nextGuides, state] = await Promise.all([getGuideSummaries(), getRecordingState()]);
      setGuides(nextGuides);
      setOperationLocked(state.operation !== null || state.isRecording);
    } catch (refreshError) {
      console.error('[frametrail] failed to load guide library', refreshError);
      setError('無法讀取本機作品庫。');
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  // Lets "回到作品庫" reuse this tab instead of opening a second library.
  useExtensionPageRegistration();

  useEffect(() => {
    void refresh();
    // Guides change from other surfaces (editor edits, popup resets, another
    // library tab); storage exposes no guides-changed signal, so returning to
    // the tab is the refresh trigger. This also shrinks the window in which a
    // stale card title could seed an EditableTitle rename.
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void refresh({ showLoading: false });
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    const unsubscribe = onRecordingStateChange((state) => {
      setOperationLocked(state.operation !== null || state.isRecording);
    });
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      unsubscribe();
    };
  }, []);

  const allTags = useMemo(
    () => [...new Set(guides.flatMap((guide) => guide.tags))].sort((a, b) => a.localeCompare(b, 'zh-TW')),
    [guides],
  );

  const visibleGuides = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase('zh-TW');
    return guides.filter((guide) => {
      if (filterTags.length > 0 && !filterTags.every((tag) => guide.tags.includes(tag))) return false;
      return !normalized || `${guide.title}\n${guide.description}`.toLocaleLowerCase('zh-TW').includes(normalized);
    });
  }, [deferredQuery, filterTags, guides]);

  const storageBytes = useMemo(() => guides.reduce((sum, guide) => sum + guide.storageBytes, 0), [guides]);

  async function run(id: string, action: () => Promise<void>, options: { refreshAfter?: boolean } = {}) {
    if (loading || operationLocked) return false;
    // The shared gate answers synchronously, so two actions fired in the same
    // event turn cannot overlap storage writes.
    const outcome = await runExclusive(id, async () => {
      setError(null);
      try {
        await action();
        if (options.refreshAfter !== false) await refresh({ showLoading: false });
        return true;
      } catch (operationError) {
        setError(reportError('[frametrail] library operation failed', operationError, '操作失敗，請再試一次。'));
        return false;
      }
    });
    return outcome ?? false;
  }

  async function createNewGuide() {
    await run('new', async () => {
      const guide = await createAndSelectGuide();
      await openSelectedGuideInEditor(guide.id);
    });
  }

  async function exportGuide(guide: GuideSummary) {
    await run(guide.id, async () => {
      const blob = await exportProjectArchive(await getSteps(guide.id), {
        metadata: {
          title: guide.title,
          description: guide.description,
          sections: guide.sections,
          tags: guide.tags,
        },
      });
      // Queues through the downloads API and keeps the object URL alive until
      // the transfer settles; a download that never starts rejects into the
      // page-level alert below.
      await downloadBlobViaBrowser(blob, exportFilename(guide.title));
      toast.success(`「${guide.title}」的可編輯檔案已開始下載。`);
    }, { refreshAfter: false });
    // A failed export reports through the page-level live alert. Close the
    // modal so it does not aria-hide that alert from assistive technology.
    setExportTarget(null);
  }

  async function deleteGuide(target: GuideSummary) {
    await run(target.id, async () => {
      // Delete atomically first. Only clear the UI selection after the
      // durable delete succeeds, and compare-and-clear so a newer
      // selection cannot be erased by this older action.
      await deleteGuidePermanently(target.id);
      await clearSelectedGuide(target.id);
    });
    // Mirrors the export flow: a failed delete reports through the page-level
    // live alert, so close the modal rather than leave the message rendered
    // (and aria-hidden) behind its overlay.
    setDeleteTarget(null);
  }

  async function importGuideFile(file: File) {
    if (file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      setError('匯入檔案超過 128 MB 安全上限。');
      return;
    }
    await run('import', async () => {
      const imported = await importProjectArchive(file);
      const fallbackTitle = file.name.replace(/\.frametrail$/i, '').slice(0, 120) || '匯入的作品';
      const guide = await createGuideFromSteps(
        imported.steps,
        {
          title: imported.metadata.title || fallbackTitle,
          description: imported.metadata.description,
          tags: imported.metadata.tags,
        },
        { sections: imported.metadata.sections },
      );
      await openSelectedGuideInEditor(guide.id);
    });
  }

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-foreground">
      <AppToaster />
      <header className="border-b border-border/80 bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-start justify-between gap-4 px-6 pt-[30px] pb-[22px] sm:px-10">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-[11px]">
              <span className="text-[15px] font-bold">FrameTrail</span>
              <span className="size-[5px] rounded-full bg-brand" aria-hidden="true" />
              <h1 className="text-[22px] font-bold text-foreground">作品庫</h1>
            </div>
            <p className="text-[13px] text-muted-foreground/90">
              所有內容只保存在這個瀏覽器設定檔中。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="mr-0.5 max-w-full text-[12.5px] font-medium text-muted-foreground/80 sm:whitespace-nowrap">
              {guides.length} 份作品 · {formatBytes(storageBytes)}
            </span>
            <input
              ref={importInput}
              type="file"
              className="sr-only"
              accept=".frametrail,application/vnd.frametrail.project+json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = '';
                if (file) void importGuideFile(file);
              }}
            />
            <Button
              variant="outline"
              className="h-[40px] gap-[7px] rounded-md px-3.5 text-[13px] font-medium"
              onClick={() => importInput.current?.click()}
              disabled={loading || operationLocked || pendingId !== null}
            >
              {pendingId === 'import' ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}匯入
            </Button>
            <Button
              variant="default"
              className="h-[40px] gap-[7px] rounded-md px-[17px] text-[13px] font-medium"
              onClick={() => void createNewGuide()}
              disabled={loading || operationLocked || pendingId !== null}
            >
              {pendingId === 'new' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}新增
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col px-6 pt-[24px] pb-[40px] sm:px-10">
        {operationLocked && (
          <Alert className="mb-4">
            <AlertDescription>錄製或補拍進行中；為避免資料寫入錯誤，目前只能瀏覽作品庫。</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4"><AlertDescription>{error}</AlertDescription></Alert>
        )}

        <div className="mb-[22px] flex flex-wrap items-center gap-[14px]">
          <div className="flex h-[44px] min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border/80 bg-card px-[15px]">
            <Search className="size-[17px] shrink-0 text-muted-foreground/70" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋標題或說明…"
              maxLength={120}
              className="min-w-0 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  'h-[44px] gap-[7px] rounded-md px-[15px] text-[13px] font-medium',
                  filterTags.length > 0 && 'border-brand bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand',
                )}
              >
                <Filter className="size-4" />
                篩選
                {filterTags.length > 0 && (
                  <Badge className="h-5 min-w-5 bg-brand px-1 text-[11px] font-semibold">
                    {filterTags.length}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              aria-labelledby="guide-tag-filter-label"
              className="app-scrollbar max-h-[min(360px,calc(100vh-140px))] w-[min(280px,calc(100vw-32px))] overflow-y-auto"
            >
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <span id="guide-tag-filter-label" className="text-[10.5px] font-semibold text-muted-foreground">
                  依標籤篩選
                </span>
                {filterTags.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilterTags([])}
                    className="shrink-0 text-xs font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    清除
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">尚無任何標籤</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map((tag) => {
                    const active = filterTags.includes(tag);
                    return (
                      <Badge
                        key={tag}
                        asChild
                        variant={active ? 'tagFilterActive' : 'tagFilter'}
                        className="max-w-full truncate"
                      >
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setFilterTags((current) => (
                            active ? current.filter((value) => value !== tag) : [...current, tag]
                          ))}
                          title={tag}
                        >
                          {tag}
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {loading ? (
          <div role="status" className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-5 animate-spin" />讀取作品庫…
          </div>
        ) : visibleGuides.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-border bg-card px-6 text-center">
            <PencilLine className="mb-4 size-8 text-brand" />
            <h2 className="font-medium">{query || filterTags.length > 0 ? '找不到符合的作品' : '建立第一份作品'}</h2>
            {!query && filterTags.length === 0 && <Button className="mt-4" onClick={() => void createNewGuide()}>新增</Button>}
          </div>
        ) : (
          <ul className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleGuides.map((guide) => {
              const pending = pendingId === guide.id;
              // While any operation is in flight, `run` rejects further actions;
              // disabling the other cards makes that lock visible instead of
              // letting their buttons silently no-op.
              const actionsLocked = operationLocked || pendingId !== null;
              const otherActionPending = pendingId !== null && !pending;
              const lockedTitle = (title: string) => (otherActionPending ? '另一項操作進行中' : title);
              const visibleTags = guide.tags.slice(0, 3);
              const hiddenTagCount = guide.tags.length - visibleTags.length;
              return (
                <li
                  key={guide.id}
                  className="group flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-[0_1px_3px_rgba(28,28,28,0.04)] transition-all duration-200 hover:border-foreground/15 hover:shadow-[0_12px_32px_-14px_rgba(28,28,28,0.24)] dark:hover:shadow-[0_12px_32px_-14px_rgba(0,0,0,0.6)]"
                >
                  <div className="flex flex-1 flex-col gap-2.5 p-[15px_16px]">
                    {visibleTags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {visibleTags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="max-w-full truncate">
                            ＃{tag}
                          </Badge>
                        ))}
                        {hiddenTagCount > 0 && <Badge variant="secondary">+{hiddenTagCount}</Badge>}
                      </div>
                    )}
                    <EditableTitle
                      value={guide.title}
                      fallback={UNTITLED_GUIDE_TITLE}
                      label="作品名稱"
                      disabled={actionsLocked}
                      // `run` reports the reason through the page-level alert
                      // and answers false when the write was refused or failed;
                      // rejecting rolls the field back to the stored title.
                      onCommit={async (title) => {
                        const saved = await run(guide.id, async () => { await updateGuide(guide.id, { title }); });
                        if (!saved) throw new Error('Guide rename was not applied.');
                      }}
                      className="w-full rounded-md border border-transparent px-1 py-0.5 -ml-1 text-[15px] font-semibold leading-[1.35] text-foreground hover:border-border focus:border-border focus:bg-background focus:ring-2 focus:ring-ring disabled:opacity-70"
                    />
                    <p className="line-clamp-2 min-h-10 text-[12.5px] leading-[1.55] text-muted-foreground">
                      {guide.description || '尚未加入作品說明'}
                    </p>
                    <div
                      className="mt-0.5 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground"
                      title={`${guide.entryCount} 個畫面／${guide.stepCount} 個標註 · ${formatBytes(guide.storageBytes)}`}
                    >
                      <span>{guide.entryCount} 個畫面</span>
                      <span className="size-[3px] rounded-full bg-current opacity-40" />
                      <span>{guide.stepCount} 標註</span>
                      <span className="size-[3px] rounded-full bg-current opacity-40" />
                      <span>{formatBytes(guide.storageBytes)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70">
                      <span className="size-3 opacity-60"><RotateCcw className="size-3" /></span>
                      更新於 {formatDate(guide.updatedAt)}
                    </div>
                    <div className="flex-1" />
                    <div className="mt-1.5 flex items-center gap-[5px] border-t border-border/70 pt-[12px]">
                      <Button
                        size="sm"
                        className="h-8 min-w-0 flex-1 gap-1.5 rounded-md px-2.5 text-[12.5px] font-semibold"
                        title={lockedTitle('開啟')}
                        onClick={() => void run(guide.id, () => openSelectedGuideInEditor(guide.id))}
                        disabled={actionsLocked}
                      >
                        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <PencilLine className="size-[14px]" />}開啟
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0 rounded-md text-foreground/50 hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white"
                        title={lockedTitle('複製')}
                        aria-label="複製"
                        onClick={() => void run(guide.id, async () => { await duplicateGuide(guide.id); })}
                        disabled={actionsLocked}
                      >
                        <Copy className="size-[15px]" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0 rounded-md text-foreground/50 hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white"
                        title={lockedTitle('匯出可編輯 .frametrail 檔案')}
                        aria-label={`匯出 ${guide.title}`}
                        onClick={() => setExportTarget(guide)}
                        disabled={actionsLocked}
                      >
                        <Download className="size-[15px]" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0 rounded-md text-foreground/50 hover:bg-danger-soft hover:text-danger dark:text-white/55"
                        title={lockedTitle('刪除')}
                        aria-label="刪除"
                        onClick={() => setDeleteTarget(guide)}
                        disabled={actionsLocked}
                      >
                        <Trash2 className="size-[15px]" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
            {filterTags.length === 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => void createNewGuide()}
                  disabled={loading || operationLocked || pendingId !== null}
                  className="flex min-h-[220px] w-full flex-col items-center justify-center gap-3 rounded-md border-[1.5px] border-dashed border-border/80 bg-transparent text-muted-foreground transition-all duration-200 hover:border-brand hover:bg-brand-bg-soft hover:text-brand-text"
                >
                  <span className="flex size-11 items-center justify-center rounded-full bg-foreground/5">
                    <Plus className="size-5" />
                  </span>
                  <span className="text-xs font-semibold">新增</span>
                </button>
              </li>
            )}
          </ul>
        )}
      </main>

      <ConfirmationDialog
        open={exportTarget !== null}
        title="匯出可編輯檔案？"
        description={exportTarget
          ? `將下載 ${exportFilename(exportTarget.title)}。檔案包含原始截圖、標註、遮罩、說明與章節，可再次匯入 FrameTrail 編輯；因含未套用遮罩的原始截圖，請勿直接公開分享。`
          : ''}
        confirmLabel="下載 .frametrail"
        confirmVariant="default"
        pendingLabel="匯出中"
        pending={exportTarget ? pendingId === exportTarget.id : false}
        onOpenChange={(open) => { if (!open) setExportTarget(null); }}
        onConfirm={() => { if (exportTarget) void exportGuide(exportTarget); }}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title="永久刪除這份作品？"
        description="原始截圖、標註、遮罩與說明都會從本機刪除。建議先匯出 .frametrail 可編輯檔案。"
        confirmLabel="永久刪除"
        pending={deleteTarget ? pendingId === deleteTarget.id : false}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={() => { if (deleteTarget) void deleteGuide(deleteTarget); }}
      />
    </div>
  );
}
