import './globals.css';
import './use-ui-settings'; // apply saved theme/font before first paint on boot
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { ErrorBoundary } from './error-boundary';
import { PreflightGate } from './preflight-gate';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <PreflightGate>
        <App />
      </PreflightGate>
    </ErrorBoundary>
  </StrictMode>,
);
