import { cn } from '@/lib/shared/utils';

interface Props {
  className?: string;
}

/**
 * FrameTrail's sticker mascot: a little screenshot frame with a face. Colours
 * are fixed rather than themed — like a sticker, it looks the same on a light
 * or dark page. Decorative only; callers supply any accessible name.
 */
export default function Mascot({ className }: Props) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false" className={cn('size-7 shrink-0', className)}>
      <rect x="4.5" y="7" width="31" height="26" rx="9" fill="#a8d8ff" stroke="#1f1b16" strokeWidth="2.4" />
      <rect x="10.5" y="12.5" width="19" height="15" rx="4.5" fill="#fffdf8" stroke="#1f1b16" strokeWidth="1.8" />
      <circle cx="16.5" cy="19.5" r="1.9" fill="#1f1b16" />
      <circle cx="23.5" cy="19.5" r="1.9" fill="#1f1b16" />
      <path d="M18.3 23.2q1.7 1.4 3.4 0" fill="none" stroke="#1f1b16" strokeWidth="1.5" strokeLinecap="round" />
      <ellipse cx="13.6" cy="23" rx="1.9" ry="1.1" fill="#ffb5c5" />
      <ellipse cx="26.4" cy="23" rx="1.9" ry="1.1" fill="#ffb5c5" />
      <circle cx="8.8" cy="10.6" r="1.2" fill="#1f1b16" />
      <circle cx="31.2" cy="10.6" r="1.2" fill="#1f1b16" />
    </svg>
  );
}
