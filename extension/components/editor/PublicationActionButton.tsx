import {
  ChevronRight,
  FileCode2,
  FileDown,
  FileText,
  Images,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/shared/utils';

export type PublicationAction = 'markdown' | 'html' | 'pdf' | 'images';
export type ActionPresentation = 'featured' | 'compact';

type PublicationActionContent = {
  label: string;
  description: string;
  format: string;
  badge?: string;
  icon: LucideIcon;
};

export const PUBLICATION_ACTION_CONTENT: Readonly<Record<PublicationAction, PublicationActionContent>> = {
  markdown: {
    label: '下載 Markdown',
    description: '包含 Markdown 文件與所有標註圖片，解壓後即可編輯。',
    format: '.zip · Markdown + 圖片',
    icon: FileText,
  },
  html: {
    label: '下載自包含 HTML',
    description: '完整保留排版與圖片，單一檔案即可離線開啟。',
    format: '.html · 最適合分享',
    badge: '推薦',
    icon: FileCode2,
  },
  pdf: {
    label: '下載 PDF',
    description: '將圖片、說明與標註整理成可直接分享的 PDF 文件。',
    format: '.pdf · 離線閱讀',
    icon: FileDown,
  },
  images: {
    label: '下載圖片',
    description: '只匯出已套用標註與遮罩的步驟圖片。',
    format: '.zip · 個別圖片',
    icon: Images,
  },
};

interface PublicationActionButtonProps {
  action: PublicationAction;
  busy: boolean;
  disabled: boolean;
  pendingAction: PublicationAction | null;
  presentation: ActionPresentation;
  descriptionId: string;
  onClick: () => void;
}

export default function PublicationActionButton({
  action,
  busy,
  disabled,
  pendingAction,
  presentation,
  descriptionId,
  onClick,
}: PublicationActionButtonProps) {
  const content = PUBLICATION_ACTION_CONTENT[action];
  const Icon = content.icon;
  const pending = pendingAction === action;
  const featured = presentation === 'featured';

  return (
    <button
      type="button"
      disabled={busy || disabled}
      aria-busy={pending}
      aria-describedby={descriptionId}
      onClick={onClick}
      className={cn(
        'group relative flex w-full overflow-hidden border bg-white text-left transition-[border-color,background-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-blue-600/35 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-stone-900',
        featured
          ? 'min-h-36 flex-col rounded-lg border-stone-200 p-5 hover:-translate-y-0.5 hover:border-lime-600 hover:shadow-md dark:border-stone-700 dark:hover:border-lime-400'
          : 'min-h-20 items-center gap-3 rounded-lg border-stone-200 px-4 py-3 hover:border-stone-400 hover:bg-stone-50 dark:border-stone-700 dark:hover:border-stone-500 dark:hover:bg-stone-800',
        pending && 'border-lime-600 bg-lime-50 dark:border-lime-400 dark:bg-lime-950/30',
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center text-lime-800 transition-colors dark:text-lime-300',
          featured
            ? 'mb-5 size-11 rounded-lg bg-lime-100 dark:bg-lime-950'
            : 'size-9 rounded-md bg-stone-100 group-hover:bg-lime-100 dark:bg-stone-800 dark:group-hover:bg-lime-950',
        )}
        aria-hidden="true"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      </span>

      <span className={cn('min-w-0', featured ? 'w-full' : 'flex-1')}>
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">{content.label}</span>
          {content.badge && (
            <span className="rounded-full bg-lime-100 px-2 py-0.5 text-[10px] font-bold text-lime-800 dark:bg-lime-950 dark:text-lime-300">
              {content.badge}
            </span>
          )}
        </span>
        <span
          id={descriptionId}
          className={cn(
            'block leading-5 text-stone-600 dark:text-stone-300',
            featured ? 'mt-1.5 text-xs' : 'mt-0.5 text-xs',
          )}
        >
          {content.description}
        </span>
        <span className="mt-2 block text-[11px] font-medium text-stone-500 dark:text-stone-400">
          {pending ? `正在準備${content.label.replace(/^下載|^開啟|^複製/, '')}…` : content.format}
        </span>
      </span>

      {!featured && (
        <ChevronRight
          className="size-4 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5 dark:text-stone-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
