// pi-web 백엔드 API 클라이언트.
// 모든 호출은 Vite 프록시(dev) 또는 같은 오리진(prod)의 /api 로 간다.

export interface DirectoryInfo {
  cwd: string;
  sessionCount: number;
  lastModified: string;
}

export interface SessionInfo {
  path: string;
  id: string;
  name: string | null;
  firstMessage: string;
  messageCount: number;
  created: string;
  modified: string;
  live: boolean;
}

export interface LockRecord {
  sessionPath: string;
  owner: "pi" | "pi-web";
  pid: number;
  host: string;
  label?: string;
  since: number;
  token: string;
}

export interface SessionDetail {
  path: string;
  cwd: string;
  name: string | null;
  leafId: string | null;
  entries: SessionEntry[];
  live: boolean;
}

// 세션 엔트리 — 백엔드의 SessionManager.getEntries() 결과. 느슨하게 타입.
export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
  [k: string]: unknown;
}

export interface AgentMessage {
  role: string;
  content: unknown;
  model?: string;
  [k: string]: unknown;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionStats {
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  [k: string]: unknown;
}

export interface SessionControls {
  live: boolean;
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  name: string | null;
  stats: SessionStats | null;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return res.json();
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return res.json();
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return { error: res.statusText };
  }
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export const api = {
  directories: () =>
    getJSON<{ directories: DirectoryInfo[] }>("/api/directories").then((r) => r.directories),

  sessions: (cwd: string) =>
    getJSON<{ cwd: string; sessions: SessionInfo[] }>(
      `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
    ).then((r) => r.sessions),

  session: (path: string) =>
    getJSON<SessionDetail>(`/api/session?path=${encodeURIComponent(path)}`),

  models: () => getJSON<{ models: ModelInfo[] }>("/api/models").then((r) => r.models),

  locks: () => getJSON<{ locks: LockRecord[] }>("/api/locks").then((r) => r.locks),

  live: () =>
    getJSON<{ live: { key: string; cwd: string; streaming: boolean; lockMine: boolean }[] }>(
      "/api/live",
    ).then((r) => r.live),

  // 라이브 세션 열기 (락 확보). 409 면 ApiError(status=409, body.current)
  open: (path: string, force = false) =>
    postJSON<{ live: boolean; locked: boolean }>("/api/session/open", { path, force }),

  // 프롬프트 전송. images = data URL 배열(첨부). 409 locked/revoked 면 ApiError
  prompt: (path: string, message: string, force = false, images?: string[]) =>
    postJSON<{ accepted: boolean }>("/api/session/prompt", { path, message, force, images }),

  dispose: (path: string) =>
    fetch(`/api/session/live?path=${encodeURIComponent(path)}`, { method: "DELETE" }),

  // 세션 컨트롤/통계 스냅샷 (info 패널). 런타임 없으면 live:false.
  controls: (path: string) =>
    getJSON<SessionControls>(`/api/session/controls?path=${encodeURIComponent(path)}`),

  // 모델 변경. 409 면 ApiError.
  setModel: (path: string, provider: string, id: string, force = false) =>
    postJSON<SessionControls>("/api/session/model", { path, provider, id, force }),

  // 사고 수준(efficiency) 변경. 409 면 ApiError.
  setThinking: (path: string, level: ThinkingLevel, force = false) =>
    postJSON<SessionControls>("/api/session/thinking", { path, level, force }),

  // 세션 이름 변경. 409 면 ApiError.
  rename: (path: string, name: string, force = false) =>
    postJSON<SessionControls>("/api/session/rename", { path, name, force }),
};

// ── SSE 구독 ───────────────────────────────────────────────────────────
// EventSource 는 GET 쿼리만 되므로 path 를 쿼리로 넘긴다.
// 반환된 함수를 호출하면 연결을 닫는다.
export function subscribeEvents(
  path: string,
  onEvent: (event: any) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(`/api/session/events?path=${encodeURIComponent(path)}`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* 빈 ping 등 무시 */
    }
  };
  if (onError) es.onerror = onError;
  return () => es.close();
}
