import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Surface name shown in the fallback copy, e.g. 「編輯器」. */
  label?: string;
  /** Called when the user retries; the boundary clears its own error first. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time throws so a single broken subtree cannot white-screen a
 * whole extension surface. Error boundaries must be class components: React has
 * no hook equivalent for `getDerivedStateFromError`.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[frametrail] ${this.props.label ?? '畫面'}發生未預期錯誤`,
      error,
      errorInfo.componentStack,
    );
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { label, onReset } = this.props;

    return (
      <div
        role="alert"
        className="flex w-full flex-1 flex-col items-center justify-center gap-4 bg-card px-5 py-8 text-center"
      >
        <span className="flex size-11 items-center justify-center rounded-full border border-border">
          <TriangleAlert className="size-5 text-destructive" />
        </span>
        <div className="flex w-full max-w-[280px] flex-col items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {label ? `${label}發生錯誤` : '發生錯誤'}
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            畫面無法正常顯示，你的資料仍安全保存。請重新載入再試一次。
          </p>
          <p className="w-full truncate rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
            {error.message || '未知錯誤'}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            <RotateCcw />
            重新載入
          </Button>
          {onReset && (
            <Button size="sm" variant="outline" onClick={this.handleRetry}>
              重試
            </Button>
          )}
        </div>
      </div>
    );
  }
}
