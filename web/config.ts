// API base URL + runtime environment detection.
//
// - Browser (dev): empty string -> relative /api, handled by the Vite proxy (5173->4317).
// - Browser (prod, pnpm start): empty string -> same origin (backend serves static).
// - Tauri dev: the WebView loads from Vite (localhost:5173) -> relative path + proxy (no CORS).
// - Tauri prod: the backend comes up on a dynamic port and Rust injects it via window.__PI_GUI_PORT__.
//   It connects to that port's absolute path (127.0.0.1:<port>) (the backend allows local-origin CORS).

declare global {
  interface Window {
    __PI_GUI_PORT__?: number;
  }
}

export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Absolute path only in Tauri prod. In dev it uses the Vite proxy (relative path).
const NEEDS_ABSOLUTE = IS_TAURI && !import.meta.env.DEV;

// The current backend base URL. In Tauri prod, reads the injected dynamic port (at call time).
export function apiBase(): string {
  if (!NEEDS_ABSOLUTE) return '';
  const port = typeof window !== 'undefined' ? window.__PI_GUI_PORT__ : undefined;
  // If the port hasn't arrived yet, empty string (relative path) - waitForBackend guards this.
  return port ? `http://127.0.0.1:${port}` : '';
}

// Builds the absolute/relative URL for an /api/... path appropriate to the environment.
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

// WebSocket URL (/ws). Converts an http(s) origin to ws(s).
//  - Tauri prod: ws://127.0.0.1:<port>/ws on the injected dynamic port
//  - otherwise (dev/prod browser): based on the current origin (in dev the Vite proxy forwards /ws).
export function wsUrl(path = '/ws'): string {
  const base = apiBase();
  if (base) return base.replace(/^http/, 'ws') + path;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${path}`;
  }
  return path;
}

// Tauri prod: wait until Rust injects the dynamic port.
// (Right after the WebView loads, window.__PI_GUI_PORT__ may not exist yet.)
export function waitForBackendPort(timeoutMs = 10000): Promise<void> {
  if (!NEEDS_ABSOLUTE) return Promise.resolve();
  if (window.__PI_GUI_PORT__) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.__PI_GUI_PORT__ || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

// Count of in-progress (streaming) sessions - used for Tauri's quit confirmation.
// Multiple sessions can each stream, so aggregate as a count to decide busy.
let activeStreams = 0;
export function reportStreaming(streaming: boolean): void {
  if (!IS_TAURI) return;
  activeStreams = Math.max(0, activeStreams + (streaming ? 1 : -1));
  const busy = activeStreams > 0;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_busy', { busy }))
    .catch(() => undefined);
}
