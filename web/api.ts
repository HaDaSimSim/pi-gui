// pi-gui 백엔드 API 클라이언트.
// 모든 호출은 Vite 프록시(dev) 또는 같은 오리진(prod)의 /api 로 간다.
// Tauri 에서는 apiUrl() 이 절대경로(127.0.0.1:4317)로 바꿜준다.

import { apiUrl } from "./config";

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

export interface FooterData {
  cwd: string;
  name: string | null;
  branch: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  live: boolean;
  model?: ModelInfo | null;
  thinkingLevel?: ThinkingLevel | null;
  supportsThinking?: boolean;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

export interface GitFileChange {
  path: string;
  index: string;
  work: string;
  untracked: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relTime: string;
  refs: string;
  parents: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branches: GitBranch[];
  commits: GitCommit[];
}

export interface GitCommitFile {
  path: string;
  added: number;
  deleted: number;
  status: string;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  relTime: string;
  parents: string[];
  refs: string;
  files: GitCommitFile[];
  insertions: number;
  deletions: number;
}

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
  const res = await fetch(apiUrl(url));
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return res.json();
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
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

  // 새 세션 경로 발급 (cwd 에서). pending: 첫 프롬프트 전엔 파일 없음.
  newSession: (cwd: string) =>
    postJSON<{ path: string; cwd: string; id: string; pending: boolean }>("/api/session/new", { cwd }),

  // 라이브 세션 열기 (락 확보). 409 면 ApiError(status=409, body.current)
  open: (path: string, force = false) =>
    postJSON<{ live: boolean; locked: boolean }>("/api/session/open", { path, force }),

  // 프롬프트 전송. images = data URL 배열(첨부), cwd = pending 세션 최초 생성용. 409 면 ApiError
  prompt: (path: string, message: string, force = false, images?: string[], cwd?: string) =>
    postJSON<{ accepted: boolean }>("/api/session/prompt", { path, message, force, images, cwd }),

  // 진행 중인 응답 중단.
  abort: (path: string) => postJSON<{ aborted: boolean }>("/api/session/abort", { path }),

  // UI 브릿지 응답 (confirm/select/input 다이얼로그 결과).
  uiResponse: (path: string, id: string, value: unknown) =>
    postJSON<{ ok: boolean }>("/api/session/ui-response", { path, id, value }),

  // 세션 삭제 (jsonl 제거). 라이브/락 점유 중이면 409.
  deleteSession: (path: string) =>
    fetch(apiUrl(`/api/session?path=${encodeURIComponent(path)}`), { method: "DELETE" }),

  dispose: (path: string) =>
    fetch(apiUrl(`/api/session/live?path=${encodeURIComponent(path)}`), { method: "DELETE" }),

  // 세션 컨트롤/통계 스냅샷 (info 패널). 런타임 없으면 live:false.
  controls: (path: string) =>
    getJSON<SessionControls>(`/api/session/controls?path=${encodeURIComponent(path)}`),

  // 슬래시 커맨드 목록 (extension + skill). 라이브 런타임 없으면 빈 배열.
  commands: (path: string) =>
    getJSON<{ commands: { name: string; description?: string; source: string }[] }>(
      `/api/session/commands?path=${encodeURIComponent(path)}`,
    ).then((r) => r.commands),

  // 푸터 데이터 (TUI 푸터 미러링). 런타임 없어도 파일에서 토큰/비용 집계.
  footer: (path: string, cwd?: string) =>
    getJSON<FooterData>(
      `/api/session/footer?path=${encodeURIComponent(path)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`,
    ),

  // git 상태 (브랜치/변경파일/커밋그래프). 읽기 전용.
  git: (cwd: string) => getJSON<GitStatus>(`/api/git?cwd=${encodeURIComponent(cwd)}`),

  // git 단일 커밋 상세. 읽기 전용.
  gitCommit: (cwd: string, hash: string) =>
    getJSON<GitCommitDetail>(`/api/git/commit?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`),

  // 디렉터리 브라우저 (새 세션 폴더 선택용). path 없으면 홈에서 시작.
  fsList: (path?: string) =>
    getJSON<{ path: string; parent: string | null; dirs: string[] }>(
      `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

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
  const es = new EventSource(apiUrl(`/api/session/events?path=${encodeURIComponent(path)}`));
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
