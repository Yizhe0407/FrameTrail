import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import '@/assets/tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="FrameTrail">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
