// 단일 WebSocket 이벤트 버스.
//
// 왜: 브라우저는 origin 당 HTTP/1.1 연결이 6개로 제한된다. 탭마다 SSE(EventSource)를
// 영구히 열면 6개 탭에서 연결 슬롯이 동나, 이후 모든 fetch 가 큐에 갇혀 멈춘다.
// WebSocket 은 그 6연결 풀에 안 들어가므로, 소켓 1개로 모든 세션 이벤트를 멀티플렉싱한다.
//
// 프로토콜:
//  - 클라이언트 → 서버: { type: "subscribe", paths: string[] }  (구독할 세션 path 집합)
//  - 서버 → 클라이언트: { path: string, event: any }            (해당 세션의 이벤트)

import { wsUrl } from "./config";

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
    ws.send(JSON.stringify({ type: "subscribe", paths: currentPaths() }));
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(wsUrl("/ws"));
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 500;
    sendSubscriptions(); // 재연결 시 현재 구독 집합 복원
  };
  ws.onmessage = (e) => {
    let msg: { path?: string; event?: any } | null = null;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.path !== "string") return;
    const set = listeners.get(msg.path);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(msg.event);
      } catch {
        /* 리스너 격리 */
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

// 한 세션 path 의 이벤트를 구독한다. 반환 함수 호출 시 해제.
export function subscribePath(path: string, fn: Listener): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(fn);
  connect();
  sendSubscriptions(); // 새 path 를 서버에 알림 (소켓 열려 있으면 즉시)

  return () => {
    const s = listeners.get(path);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(path);
    sendSubscriptions(); // 빠진 path 를 서버에 알림
    // 구독이 모두 사라지면 소켓을 닫아 자원 반납.
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
