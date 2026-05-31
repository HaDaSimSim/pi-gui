// API 베이스 URL + 런타임 환경 판별.
//
// - 브라우저(dev): 빈 문자열 → 상대경로 /api, Vite 프록시(5173→4317)가 처리.
// - 브라우저(prod, pnpm start): 빈 문자열 → 같은 오리진(백엔드가 정적 서빙).
// - Tauri dev: WebView 가 Vite(localhost:5173)에서 로드되므로 역시 상대경로
//   + Vite 프록시를 탄다 (CORS 없음).
// - Tauri prod: WebView 오리진이 tauri://localhost 라 프록시가 없다.
//   절대경로(127.0.0.1:4317)로 직접 붙는다 (백엔드가 로컬 origin CORS 허용).

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 절대경로는 "Tauri 구(prod 빌드)"에서만 쓴다. dev 는 Vite 프록시를 타야 CORS 가 없다.
// 포트는 VITE_PI_GUI_PORT 로 오버라이드 가능(기본 4317) — 테스트/충돌 회피용.
const PORT = import.meta.env.VITE_PI_GUI_PORT ?? "4317";
export const API_BASE = IS_TAURI && !import.meta.env.DEV ? `http://127.0.0.1:${PORT}` : "";

// /api/... 경로를 환경에 맞는 절대/상대 URL 로 만든다.
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
