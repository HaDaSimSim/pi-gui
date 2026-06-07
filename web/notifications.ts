// Desktop notifications (Tauri only). Mirrors the conditions the pi-skills
// `telegram` extension fires on (long task done, goal status change), but fires
// a native OS notification instead — and only when the window isn't focused.
//
// In the browser build these are no-ops (IS_TAURI false). Notification payloads
// can't carry routing data through the OS, so we remember the session path of
// the most recent notification; clicking any notification focuses the window and
// jumps to that session (wired in app.tsx via onNotificationActivate).

import { IS_TAURI } from './config';

let permissionGranted = false;
let lastNotifiedPath: string | null = null;
let activateHandler: ((path: string) => void) | null = null;
let actionListenerBound = false;

// Request notification permission once at startup (Tauri only).
export async function initNotifications(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const { isPermissionGranted, requestPermission, onAction } = await import(
      '@tauri-apps/plugin-notification'
    );
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = (await requestPermission()) === 'granted';
    }
    // Bind the global click handler once: clicking a notification focuses the
    // window and routes to the last-notified session.
    if (!actionListenerBound) {
      actionListenerBound = true;
      await onAction(() => {
        void focusMainWindow();
        if (lastNotifiedPath && activateHandler) activateHandler(lastNotifiedPath);
      });
    }
  } catch {
    /* notification plugin unavailable — stay no-op */
  }
}

// Register the callback app.tsx uses to activate a tab on notification click.
export function onNotificationActivate(fn: (path: string) => void): void {
  activateHandler = fn;
}

async function focusMainWindow(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.unminimize().catch(() => undefined);
    await w.setFocus();
  } catch {
    /* ignore */
  }
}

// Is the app window currently focused? When focused we skip notifications.
export async function windowFocused(): Promise<boolean> {
  if (!IS_TAURI) return typeof document !== 'undefined' ? document.hasFocus() : true;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isFocused();
  } catch {
    return true;
  }
}

// Fire a desktop notification for a session, remembering its path for click routing.
export async function notifySession(path: string, title: string, body: string): Promise<void> {
  if (!IS_TAURI || !permissionGranted) return;
  lastNotifiedPath = path;
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
  } catch {
    /* ignore */
  }
}
