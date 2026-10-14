import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

const alertVariants = cva(
  'relative flex w-full items-start gap-2 rounded-md border-2 px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        /** Body text stays ink for legibility; the red outline and icon carry the severity. */
        destructive: 'border-recording bg-danger-soft text-foreground [&>svg]:text-danger',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('min-w-0 leading-snug', className)} {...props} />;
}

export { Alert, AlertDescription };
