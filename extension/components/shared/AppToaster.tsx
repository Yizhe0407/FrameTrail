import { Toaster, type ToasterProps } from 'react-hot-toast';

/**
 * App-wide transient feedback for actions that already finished; unlike inline
 * banners it doesn't take a layout slot. Errors stay as persistent in-page
 * alerts instead. Colours use theme tokens so toasts follow OS dark mode.
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
