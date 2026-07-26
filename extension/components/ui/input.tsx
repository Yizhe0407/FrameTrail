import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/**
 * The bordered text field. Its sibling Textarea was already here while this was
 * not, so every standard field hand-rolled its own border and focus treatment —
 * three different focus styles for the same interaction. Chrome-less inline
 * editors (a title you click to rename, the search box inside its own bordered
 * shell) are deliberately not this component: they must not carry a border,
 * background, or shadow of their own.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
