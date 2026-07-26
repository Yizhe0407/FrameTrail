import { Toaster, type ToasterProps } from 'react-hot-toast';

/**
 * The app-wide transient feedback surface. Notices announce that something
 * already finished ("匯出已開始", "補拍完成"), so they must not hold a slot in the
 * layout the way the old inline banners did — a banner that pushes the editor
 * down after every operation is more disruptive than the news it carries.
 *
 * Errors deliberately stay as persistent in-page alerts: a message the user has
 * to act on cannot be allowed to time out.
 *
 * Colours come from the theme tokens rather than react-hot-toast's defaults so
 * toasts follow the OS dark-mode switch like every other surface.
 */
export default function AppToaster({ position = 'top-center' }: { position?: ToasterProps['position'] }) {
  return (
    <Toaster
      position={position}
      gutter={10}
      containerStyle={{ zIndex: 60 }}
      toastOptions={{
        duration: 4_000,
        style: {
          maxWidth: '440px',
          padding: '10px 14px',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: 'var(--card)',
          color: 'var(--foreground)',
          boxShadow: 'var(--shadow-menu)',
          fontSize: '13px',
          lineHeight: '1.5',
        },
        success: { iconTheme: { primary: 'var(--brand)', secondary: 'var(--card)' } },
        error: { iconTheme: { primary: 'var(--destructive)', secondary: 'var(--card)' } },
      }}
    />
  );
}
