// API 베이스 URL + 런타임 환경 판별.
//
// - 브라우저(dev): 빈 문자열 → 상대경로 /api, Vite 프록시(5173→4317)가 처리.
// - 브라우저(prod, pnpm start): 빈 문자열 → 같은 오리진(백엔드가 정적 서빙).
// - Tauri dev: WebView 가 Vite(localhost:5173)에서 로드 → 상대경로 + 프록시 (CORS 없음).
// - Tauri prod: 백엔드가 동적 포트로 뜨고, Rust 가 window.__PI_GUI_PORT__ 로 주입.
//   그 포트의 절대경로(127.0.0.1:<port>)로 붙는다 (백엔드가 로컬 origin CORS 허용).

declare global {
  interface Window {
    __PI_GUI_PORT__?: number;
  }
}

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Tauri prod 에서만 절대경로. dev 는 Vite 프록시(상대경로).
const NEEDS_ABSOLUTE = IS_TAURI && !import.meta.env.DEV;

// 현재 백엔드 베이스 URL. Tauri prod 면 주입된 동적 포트를 읽는다(호출 시점에).
export function apiBase(): string {
  if (!NEEDS_ABSOLUTE) return "";
  const port = typeof window !== "undefined" ? window.__PI_GUI_PORT__ : undefined;
  // 포트가 아직 안 들어왔으면 빈 문자열(상대경로) — waitForBackend 가 막아준다.
  return port ? `http://127.0.0.1:${port}` : "";
}

// /api/... 경로를 환경에 맞는 절대/상대 URL 로 만든다.
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

// Tauri prod: Rust 가 동적 포트를 주입할 때까지 기다린다.
// (WebView 로드 직후엔 아직 window.__PI_GUI_PORT__ 가 없을 수 있음.)
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

// 진행 중(스트리밍) 세션 카운트 — Tauri 의 quit 확인에 쓰인다.
// 여러 세션이 각자 스트리밍할 수 있으므로 카운트로 집계해 busy 를 정한다.
let activeStreams = 0;
export function reportStreaming(streaming: boolean): void {
  if (!IS_TAURI) return;
  activeStreams = Math.max(0, activeStreams + (streaming ? 1 : -1));
  const busy = activeStreams > 0;
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("set_busy", { busy }))
    .catch(() => undefined);
}
