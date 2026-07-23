import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  FilePlus2,
  HardDrive,
  Loader2,
  PencilLine,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  createGuideFromSteps,
  deleteGuidePermanently,
  duplicateGuide,
  getGuideSummaries,
  getSteps,
  updateGuide,
  type GuideSummary,
} from '@/lib/storage/db';
import { clearSelectedGuide, createAndSelectGuide, openSelectedGuideInEditor } from '@/lib/guide/guide-actions';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import { exportProjectArchive, importProjectArchive, PROJECT_ARCHIVE_LIMITS } from '@/lib/export/project-archive';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function archiveFilename(title: string): string {
  const stem = title.normalize('NFKC').toLocaleLowerCase('zh-TW')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'frametrail-guide';
  return `${stem}.frametrail`;
}

export default function App() {
  const [guides, setGuides] = useState<GuideSummary[]>([]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuideSummary | null>(null);
  const [backupTarget, setBackupTarget] = useState<GuideSummary | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationLocked, setOperationLocked] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [nextGuides, state] = await Promise.all([getGuideSummaries(true), getRecordingState()]);
      setGuides(nextGuides);
      setOperationLocked(state.operation !== null || state.isRecording);
    } catch (refreshError) {
      console.error('[frametrail] failed to load guide library', refreshError);
      setError('無法讀取本機作品庫。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return onRecordingStateChange((state) => {
      setOperationLocked(state.operation !== null || state.isRecording);
    });
  }, []);

  const visibleGuides = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase('zh-TW');
    return guides.filter((guide) => {
      if (!showArchived && guide.archivedAt !== null) return false;
      if (showArchived && guide.archivedAt === null) return false;
      return !normalized || `${guide.title}\n${guide.description}`.toLocaleLowerCase('zh-TW').includes(normalized);
    });
  }, [deferredQuery, guides, showArchived]);

  const storageBytes = useMemo(() => guides.reduce((sum, guide) => sum + guide.storageBytes, 0), [guides]);

  async function run(id: string, action: () => Promise<void>) {
    if (pendingId || operationLocked) return;
    setPendingId(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (operationError) {
      console.error('[frametrail] library operation failed', operationError);
      setError(operationError instanceof Error ? operationError.message : '操作失敗，請再試一次。');
    } finally {
      setPendingId(null);
    }
  }

  async function createNewGuide() {
    await run('new', async () => {
      const guide = await createAndSelectGuide();
      await openSelectedGuideInEditor(guide.id);
    });
  }

  async function downloadBackup(guide: GuideSummary) {
    await run(guide.id, async () => {
      const blob = await exportProjectArchive(await getSteps(guide.id), {
        metadata: {
          title: guide.title,
          description: guide.description,
          sections: guide.sections,
        },
      });
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({ url, filename: archiveFilename(guide.title), saveAs: true });
      } finally {
        URL.revokeObjectURL(url);
      }
      setBackupTarget(null);
    });
  }

  async function importBackup(file: File) {
    if (file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      setError('備份檔超過 128 MB 安全上限。');
      return;
    }
    await run('import', async () => {
      const imported = await importProjectArchive(file, { includeMetadata: true });
      const fallbackTitle = file.name.replace(/\.frametrail$/i, '').slice(0, 120) || '匯入的教學';
      const guide = await createGuideFromSteps(
        imported.steps,
        {
          title: imported.metadata.title || fallbackTitle,
          description: imported.metadata.description,
        },
        { sections: imported.metadata.sections },
      );
      await openSelectedGuideInEditor(guide.id);
    });
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <header className="border-b border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-5 sm:px-8">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">FrameTrail 作品庫</h1>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">所有內容只保存在這個瀏覽器設定檔中。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
            <HardDrive className="size-4" />
            {guides.length} 份教學 · {formatBytes(storageBytes)}
          </div>
          <input
            ref={importInput}
            type="file"
            className="sr-only"
            accept=".frametrail,application/vnd.frametrail.project+json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) void importBackup(file);
            }}
          />
          <Button variant="outline" onClick={() => importInput.current?.click()} disabled={operationLocked || pendingId !== null}>
            {pendingId === 'import' ? <Loader2 className="animate-spin" /> : <Upload />}匯入備份
          </Button>
          <Button onClick={() => void createNewGuide()} disabled={operationLocked || pendingId !== null}>
            {pendingId === 'new' ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
            新增教學
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-6 sm:px-8">
        {operationLocked && (
          <Alert>
            <AlertDescription>錄製或補拍進行中；為避免資料寫入錯誤，目前只能瀏覽作品庫。</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-64 flex-1">
            <span className="sr-only">搜尋教學</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋標題或說明"
              maxLength={120}
              className="h-10 w-full rounded-md border border-stone-300 bg-white pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-stone-700 dark:bg-stone-900"
            />
          </label>
          <Button variant="outline" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? <ArchiveRestore /> : <Archive />}
            {showArchived ? '返回使用中' : '查看封存'}
          </Button>
        </div>

        {loading ? (
          <div role="status" className="flex min-h-64 items-center justify-center text-sm text-stone-500">
            <Loader2 className="mr-2 size-5 animate-spin" />讀取作品庫…
          </div>
        ) : visibleGuides.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50 px-6 text-center dark:border-stone-700 dark:bg-stone-900">
            <PencilLine className="mb-4 size-8 text-lime-700 dark:text-lime-400" />
            <h2 className="font-medium">{query ? '找不到符合的教學' : showArchived ? '沒有封存的教學' : '建立第一份教學'}</h2>
            {!query && !showArchived && <Button className="mt-4" onClick={() => void createNewGuide()}>新增教學</Button>}
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleGuides.map((guide) => {
              const pending = pendingId === guide.id;
              return (
                <li key={guide.id} className="flex min-h-56 flex-col rounded-lg border border-stone-200 bg-stone-50 p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                  <input
                    aria-label="教學名稱"
                    defaultValue={guide.title}
                    maxLength={120}
                    disabled={operationLocked || pending}
                    onBlur={(event) => {
                      const title = event.currentTarget.value.trim();
                      if (title && title !== guide.title) {
                        void run(guide.id, async () => { await updateGuide(guide.id, { title }); });
                      } else {
                        event.currentTarget.value = guide.title;
                      }
                    }}
                    className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-base font-semibold outline-none hover:border-stone-300 focus:border-stone-300 focus:bg-white focus:ring-2 focus:ring-blue-600 disabled:opacity-70 dark:hover:border-stone-700 dark:focus:border-stone-700 dark:focus:bg-stone-950"
                  />
                  <p className="mt-3 line-clamp-2 min-h-10 text-sm text-stone-500 dark:text-stone-400">
                    {guide.description || '尚未加入教學說明'}
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-stone-500 dark:text-stone-400">
                    <div><dt className="sr-only">內容數</dt><dd>{guide.entryCount} 個畫面／{guide.stepCount} 個標註</dd></div>
                    <div className="text-right"><dt className="sr-only">容量</dt><dd>{formatBytes(guide.storageBytes)}</dd></div>
                    <div className="col-span-2"><dt className="sr-only">更新時間</dt><dd>更新於 {formatDate(guide.updatedAt)}</dd></div>
                  </dl>
                  <div className="mt-auto flex flex-wrap gap-2 pt-5">
                    <Button size="sm" onClick={() => void run(guide.id, () => openSelectedGuideInEditor(guide.id))} disabled={operationLocked || pending}>
                      {pending ? <Loader2 className="animate-spin" /> : <PencilLine />}開啟
                    </Button>
                    {!showArchived && (
                      <Button size="sm" variant="outline" onClick={() => void run(guide.id, async () => { await duplicateGuide(guide.id); })} disabled={operationLocked || pending}>
                        <Copy />複製
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setBackupTarget(guide)} disabled={operationLocked || pending}>
                      <Download />備份
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void run(guide.id, async () => {
                        await updateGuide(guide.id, { archivedAt: guide.archivedAt === null ? Date.now() : null });
                        if (guide.archivedAt === null) await clearSelectedGuide(guide.id);
                      })}
                      disabled={operationLocked || pending}
                    >
                      {guide.archivedAt === null ? <Archive /> : <ArchiveRestore />}
                      {guide.archivedAt === null ? '封存' : '還原'}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-400" onClick={() => setDeleteTarget(guide)} disabled={operationLocked || pending}>
                      <Trash2 />刪除
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <ConfirmationDialog
        open={backupTarget !== null}
        title="匯出可編輯備份？"
        description="備份會包含未套用遮罩的原始截圖，請只保存在可信任的位置，不要直接公開分享。"
        confirmLabel="下載備份"
        pending={backupTarget ? pendingId === backupTarget.id : false}
        onOpenChange={(open) => { if (!open) setBackupTarget(null); }}
        onConfirm={() => { if (backupTarget) void downloadBackup(backupTarget); }}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title="永久刪除這份教學？"
        description="原始截圖、標註、遮罩與說明都會從本機刪除。建議先匯出可編輯備份。"
        confirmLabel="永久刪除"
        pending={deleteTarget ? pendingId === deleteTarget.id : false}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          void run(target.id, async () => {
            // Delete atomically first. Only clear the UI selection after the
            // durable delete succeeds, and compare-and-clear so a newer
            // selection cannot be erased by this older action.
            await deleteGuidePermanently(target.id);
            await clearSelectedGuide(target.id);
            setDeleteTarget(null);
          });
        }}
      />
    </div>
  );
}
