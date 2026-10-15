import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@/assets/tailwind.css';
import { localizeDocument, t } from '@/lib/shared/i18n';

localizeDocument(t().page.library);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label={t().common.library}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
