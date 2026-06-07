// Single WebSocket event bus.
//
// Why: browsers limit HTTP/1.1 connections to 6 per origin. Keeping an SSE (EventSource)
// permanently open per tab exhausts the connection slots across 6 tabs, after which every
// fetch gets stuck queued. WebSocket doesn't count against that 6-connection pool, so one
// socket multiplexes all session events.
//
// Protocol:
//  - client -> server: { type: "subscribe", paths: string[] }  (set of session paths to subscribe)
//  - server -> client: { path: string, event: any }            (event for that session)

import { wsUrl } from './config';

type Listener = (event: any) => void;

const listeners = new Map<string, Set<Listener>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;

function currentPaths(): string[] {
  return [...listeners.keys()];
}

function sendSubscriptions() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', paths: currentPaths() }));
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(wsUrl('/ws'));
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 500;
    sendSubscriptions(); // restore the current subscription set on reconnect
  };
  ws.onmessage = (e) => {
    let msg: { path?: string; event?: any } | null = null;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.path !== 'string') return;
    const set = listeners.get(msg.path);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(msg.event);
      } catch {
        /* listener isolation */
      }
    }
  };
  ws.onclose = () => {
    ws = null;
    if (listeners.size > 0) scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, 5000);
    connect();
  }, backoff);
}

// Subscribe to events for one session path. Call the returned function to unsubscribe.
export function subscribePath(path: string, fn: Listener): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(fn);
  connect();
  sendSubscriptions(); // notify the server of the new path (immediately if the socket is open)

  return () => {
    const s = listeners.get(path);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(path);
    sendSubscriptions(); // notify the server of the dropped path
    // If all subscriptions are gone, close the socket to release resources.
    if (listeners.size === 0 && ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      ws = null;
    }
  };
}
