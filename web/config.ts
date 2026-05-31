// API 베이스 URL + 런타임 환경 판별.
//
// - 브라우저(dev): 빈 문자열 → 상대경로 /api, Vite 프록시(5173→4317)가 처리.
// - 브라우저(prod, pnpm start): 빈 문자열 → 같은 오리진(백엔드가 정적 서빙).
// - Tauri: WebView 오리진이 tauri:// 라 상대경로가 백엔드에 안 닿는다.
//   절대경로(127.0.0.1:4317)로 직접 붙는다.

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Tauri 면 백엔드 절대 URL, 아니면 상대경로(빈 베이스).
// 포트는 VITE_PI_GUI_PORT 로 오버라이드 가능(기본 4317) — 테스트/충돌 회피용.
const PORT = import.meta.env.VITE_PI_GUI_PORT ?? "4317";
export const API_BASE = IS_TAURI ? `http://127.0.0.1:${PORT}` : "";

// /api/... 경로를 환경에 맞는 절대/상대 URL 로 만든다.
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
