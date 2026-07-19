import { MousePointerClick } from 'lucide-react';

export default function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-10 text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-800">
        <MousePointerClick className="size-[22px] text-stone-400 dark:text-stone-500" />
      </span>
      <div className="flex max-w-[380px] flex-col gap-2.5">
        <span className="text-[15px] font-semibold text-stone-800 dark:text-stone-100">尚未錄製任何步驟</span>
        <span className="text-[13px] leading-[1.9] text-stone-400 dark:text-stone-500">
          開啟要教學的頁面，點工具列的 FrameTrail 圖示，按「開始錄製」後在頁面上點擊，步驟就會顯示在這裡。
        </span>
      </div>
    </div>
  );
}
