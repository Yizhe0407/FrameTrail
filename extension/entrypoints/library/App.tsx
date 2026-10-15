import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Copy,
  Download,
  Filter,
  Loader2,
  PencilLine,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { createGuideFromSteps, deleteGuidePermanently, duplicateGuide, getGuideSummaries, updateGuide } from '@/lib/storage/guide-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { type GuideSummary } from '@/lib/storage/models';
import { clearSelectedGuide, createAndSelectGuide, openSelectedGuideInEditor } from '@/lib/guide/guide-actions';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { cn } from '@/lib/shared/utils';
import { tagHueClass } from '@/lib/shared/tag-hue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AppToaster from '@/components/shared/AppToaster';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import Mascot from '@/components/shared/Mascot';
import { reportError } from '@/components/shared/report-error';
import { usePendingAction } from '@/components/shared/use-pending-action';
import { intlLocale, t } from '@/lib/shared/i18n';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { importProjectArchive } from '@/lib/export/project-archive-import';
import { PROJECT_ARCHIVE_LIMITS } from '@/lib/export/project-archive-contract';
import { guideExportFilename } from '@/lib/export/guide-export-contract';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import { openSettings } from '@/lib/runtime/actions';

/** Derives the .frametrail archive name from the same stem the publication
 * exporters use; strips the extension the (unexported) stem helper's facade appends. */
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
      setError(t().library.loadFailed);
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  // Lets "回到作品庫" reuse this tab instead of opening a second library.
  useExtensionPageRegistration();

  useEffect(() => {
    void refresh();
    // Guides change from other surfaces (editor edits, popup resets, another library
    // tab); storage has no guides-changed signal, so returning to this tab is the trigger.
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
    () => [...new Set(guides.flatMap((guide) => guide.tags))].sort((a, b) => a.localeCompare(b, intlLocale())),
    [guides],
  );

  const visibleGuides = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase(intlLocale());
    return guides.filter((guide) => {
      if (filterTags.length > 0 && !filterTags.every((tag) => guide.tags.includes(tag))) return false;
      return !normalized || `${guide.title}\n${guide.description}`.toLocaleLowerCase(intlLocale()).includes(normalized);
    });
  }, [deferredQuery, filterTags, guides]);

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
        setError(reportError('[frametrail] library operation failed', operationError, t().library.operationFailed));
        return false;
      }
    });
    return outcome ?? false;
  }

  async function openSettingsPage() {
    try {
      await openSettings();
    } catch (settingsError) {
      console.error('[frametrail] failed to open settings', settingsError);
      setError(t().settings.openFailed);
    }
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
      // Keeps the object URL alive until the download settles; a download that
      // never starts rejects into the page-level alert below.
      await downloadBlobViaBrowser(blob, exportFilename(guide.title));
      toast.success(t().library.exportStarted(guide.title));
    }, { refreshAfter: false });
    // A failed export reports through the page-level live alert. Close the
    // modal so it does not aria-hide that alert from assistive technology.
    setExportTarget(null);
  }

  async function deleteGuide(target: GuideSummary) {
    await run(target.id, async () => {
      // Only clear the UI selection after the durable delete succeeds, and
      // compare-and-clear so a newer selection isn't erased by this older action.
      await deleteGuidePermanently(target.id);
      await clearSelectedGuide(target.id);
    });
    // Mirrors the export flow: a failed delete reports through the page-level live
    // alert, so close the modal rather than leave the message aria-hidden behind it.
    setDeleteTarget(null);
  }

  async function importGuideFile(file: File) {
    if (file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      setError(t().library.importTooLarge);
      return;
    }
    await run('import', async () => {
      const imported = await importProjectArchive(file);
      const fallbackTitle = file.name.replace(/\.frametrail$/i, '').slice(0, 120) || t().library.importedFallbackTitle;
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
    <div className="min-h-screen bg-background text-foreground">
      <AppToaster />
      <header className="border-b-2 border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-5 sm:px-10">
          <div className="flex items-center gap-3">
            <Mascot className="size-11" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-muted-foreground">FrameTrail</span>
              <h1 className="text-2xl leading-tight font-bold text-foreground">{t().library.title}</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="outline" onClick={() => void openSettingsPage()}>
              <Settings />{t().settings.open}
            </Button>
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
              onClick={() => importInput.current?.click()}
              disabled={loading || operationLocked || pendingId !== null}
            >
              {pendingId === 'import' ? <Loader2 className="animate-spin" /> : <Upload />}{t().library.import}
            </Button>
            <Button
              variant="default"
              onClick={() => void createNewGuide()}
              disabled={loading || operationLocked || pendingId !== null}
            >
              {pendingId === 'new' ? <Loader2 className="animate-spin" /> : <Plus />}{t().library.create}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col px-6 pt-6 pb-10 sm:px-10">
        {operationLocked && (
          <Alert className="mb-4">
            <AlertDescription>{t().library.lockedNotice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4"><AlertDescription>{error}</AlertDescription></Alert>
        )}

        <div className="mb-6 flex flex-wrap items-center gap-3">
          {/* The field draws the outline, so focus is shown on the whole box. */}
          <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md border-2 border-border bg-card px-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
            <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t().library.searchPlaceholder}
              aria-label={t().library.searchLabel}
              maxLength={120}
              className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn('h-11', filterTags.length > 0 && 'bg-selected text-on-accent hover:bg-selected')}
              >
                <Filter />
                {t().library.filter}
                {filterTags.length > 0 && (
                  <Badge variant="outline" className="h-5 min-w-5 px-1">
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
                <span id="guide-tag-filter-label" className="text-xs font-bold text-muted-foreground">
                  {t().library.filterByTag}
                </span>
                {filterTags.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilterTags([])}
                    className="shrink-0 rounded-sm text-xs font-bold text-brand-text outline-none focus-ring hover:underline"
                  >
                    {t().library.clearFilter}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">{t().library.noTags}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map((tag) => {
                    const active = filterTags.includes(tag);
                    return (
                      <Tooltip key={tag}>
                        <TooltipTrigger asChild>
                          <Badge
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
                            >
                              {tag}
                            </button>
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>{tag}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {loading ? (
          <div role="status" className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-5 animate-spin" />{t().library.loading}
          </div>
        ) : visibleGuides.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-card px-6 py-10 text-center">
            <Mascot className="mb-2 size-16" />
            <h2 className="text-lg font-bold">{query || filterTags.length > 0 ? t().library.noMatches : t().library.empty}</h2>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              {query || filterTags.length > 0
                ? t().library.noMatchesHint
                : t().library.emptyHint}
            </p>
            {!query && filterTags.length === 0 && (
              <Button className="mt-3" onClick={() => void createNewGuide()}><Plus />{t().library.create}</Button>
            )}
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleGuides.map((guide) => {
              const pending = pendingId === guide.id;
              // While any operation is in flight, `run` rejects further actions;
              // disabling the other cards makes that lock visible instead of a silent no-op.
              const actionsLocked = operationLocked || pendingId !== null;
              const otherActionPending = pendingId !== null && !pending;
              const lockedTitle = (title: string) => (otherActionPending ? t().library.otherActionPending : title);
              const visibleTags = guide.tags.slice(0, 3);
              const hiddenTagCount = guide.tags.length - visibleTags.length;
              return (
                <li
                  key={guide.id}
                  className="group flex flex-col overflow-hidden rounded-md border-2 border-border bg-card transition-transform duration-200 hover:-translate-y-0.5"
                >
                  <div className="flex flex-1 flex-col gap-2.5 p-4">
                    {visibleTags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {visibleTags.map((tag) => (
                          <Badge key={tag} variant="tag" className={cn('max-w-full truncate', tagHueClass(tag))}>
                            {t().library.tag(tag)}
                          </Badge>
                        ))}
                        {hiddenTagCount > 0 && <Badge variant="outline">+{hiddenTagCount}</Badge>}
                      </div>
                    )}
                    <EditableTitle
                      value={guide.title}
                      fallback={t().common.untitledGuide}
                      label={t().library.titleLabel}
                      disabled={actionsLocked}
                      // `run` reports the reason via the page-level alert and returns
                      // false on failure; rejecting here rolls the field back to the stored title.
                      onCommit={async (title) => {
                        const saved = await run(guide.id, async () => { await updateGuide(guide.id, { title }); });
                        if (!saved) throw new Error('Guide rename was not applied.');
                      }}
                      className="-ml-1.5 w-full rounded-md border-2 border-transparent px-1 py-0.5 text-base leading-snug font-bold text-foreground focus-ring hover:border-border-soft focus:border-border focus:bg-background disabled:opacity-70"
                    />
                    {guide.description && (
                      <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                        {guide.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                      <span>{t().library.screenCount(guide.entryCount)}</span>
                      <span className="size-1 rounded-full bg-current opacity-50" />
                      <span>{t().library.annotationCount(guide.stepCount)}</span>
                    </div>
                    <div className="flex-1" />
                    <div className="mt-1 flex items-center gap-1 border-t-2 border-border-soft pt-3">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            className="min-w-0 flex-1"
                            onClick={() => void run(guide.id, () => openSelectedGuideInEditor(guide.id))}
                            disabled={actionsLocked}
                          >
                            {pending ? <Loader2 className="animate-spin" /> : <PencilLine />}{t().common.open}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().common.open)}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0"
                            aria-label={t().common.duplicate}
                            onClick={() => void run(guide.id, async () => { await duplicateGuide(guide.id); })}
                            disabled={actionsLocked}
                          >
                            <Copy />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().common.duplicate)}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0"
                            aria-label={t().library.exportGuideLabel(guide.title)}
                            onClick={() => setExportTarget(guide)}
                            disabled={actionsLocked}
                          >
                            <Download />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().library.exportArchiveTooltip)}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0 hover:bg-danger-soft hover:text-danger"
                            aria-label={t().common.delete}
                            onClick={() => setDeleteTarget(guide)}
                            disabled={actionsLocked}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().common.delete)}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <ConfirmationDialog
        open={exportTarget !== null}
        title={t().library.exportDialogTitle}
        description={exportTarget
          ? t().library.exportDialogDescription(exportFilename(exportTarget.title))
          : ''}
        confirmLabel={t().library.exportDialogConfirm}
        confirmVariant="default"
        pendingLabel={t().library.exportDialogPending}
        pending={exportTarget ? pendingId === exportTarget.id : false}
        onOpenChange={(open) => { if (!open) setExportTarget(null); }}
        onConfirm={() => { if (exportTarget) void exportGuide(exportTarget); }}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title={t().library.deleteDialogTitle}
        description={t().library.deleteDialogDescription}
        confirmLabel={t().library.deleteDialogConfirm}
        pending={deleteTarget ? pendingId === deleteTarget.id : false}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={() => { if (deleteTarget) void deleteGuide(deleteTarget); }}
      />
    </div>
  );
}
