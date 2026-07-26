import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/**
 * The `tag*` variants are this project's addition to the stock shadcn set.
 * Guide tags render in several places (library card, filter toggle, edit
 * dialog) and each used to hand-roll its own pill, so one concept drifted
 * into several typographies. The stock variants stay as the vocabulary for
 * any non-tag badge added later.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
        outline: 'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        /** Filter toggle, unselected. `outline-none` because these render as a
         * button via asChild, where the native outline would double the ring. */
        tagFilter: 'border-border bg-card px-3 py-1.5 font-semibold text-muted-foreground outline-none hover:border-muted-foreground/40',
        /** Filter toggle, selected. */
        tagFilterActive: 'border-brand bg-brand px-3 py-1.5 font-semibold text-primary-foreground outline-none',
        /** Editable tag already applied to the guide (editor header, edit dialog). */
        tagEditable: 'gap-1.5 border-border/60 bg-secondary px-3 py-1 font-semibold text-foreground dark:border-white/10',
        /** Editable tag still available to add. */
        tagEditableAvailable:
          'gap-1.5 border-dashed border-border bg-background/60 px-3 py-1 font-semibold text-muted-foreground hover:border-foreground/30 dark:border-white/10',
        /** Live capture state. Soft red rather than solid `destructive`: it
         * reports an operation in progress, not a failure. */
        status: 'gap-1.5 bg-danger-soft px-2 py-1 text-[11px] font-semibold text-danger sm:px-2.5',
        /** The dashed "add a tag" control that closes the row of tags. */
        tagAction:
          'h-7 gap-1 border-dashed border-border/80 px-3 py-1 font-semibold text-muted-foreground/75 outline-none hover:border-brand hover:text-foreground dark:border-white/20 dark:text-white/60 dark:hover:text-white',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
