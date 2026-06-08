// pi-gui backend API client.
// All calls go to /api on the Vite proxy (dev) or the same origin (prod).
// On Tauri, apiUrl() rewrites them to an absolute path (127.0.0.1:4317).

import { apiUrl } from './config';
import { subscribePath } from './event-bus';

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
  draft?: boolean; // temporary session before the first message (no file yet, shown temporarily in the sidebar)
}

export interface LockRecord {
  sessionPath: string;
  owner: 'pi' | 'pi-web';
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

// Session entry — result of the backend's SessionManager.getEntries(). Loosely typed.
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

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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
  queue?: { steering: string[]; followUp: string[] };
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url));
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return res.json();
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  // Preflight check (whether pi/model/session-lock are installed).
  preflight: () =>
    getJSON<{ ok: boolean; checks: { id: string; ok: boolean; detail: string }[] }>(
      '/api/preflight',
    ),

  directories: () =>
    getJSON<{ directories: DirectoryInfo[] }>('/api/directories').then((r) => r.directories),

  sessions: (cwd: string) =>
    getJSON<{ cwd: string; sessions: SessionInfo[] }>(
      `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
    ).then((r) => r.sessions),

  session: (path: string) =>
    getJSON<SessionDetail>(`/api/session?path=${encodeURIComponent(path)}`),

  models: () => getJSON<{ models: ModelInfo[] }>('/api/models').then((r) => r.models),

  locks: () => getJSON<{ locks: LockRecord[] }>('/api/locks').then((r) => r.locks),

  live: () =>
    getJSON<{ live: { key: string; cwd: string; streaming: boolean; lockMine: boolean }[] }>(
      '/api/live',
    ).then((r) => r.live),

  // Issue a new session path (from cwd). pending: no file until the first prompt.
  newSession: (cwd: string) =>
    postJSON<{ path: string; cwd: string; id: string; pending: boolean }>('/api/session/new', {
      cwd,
    }),

  // Open a live session (acquire the lock). On 409, ApiError(status=409, body.current)
  open: (path: string, force = false) =>
    postJSON<{ live: boolean; locked: boolean }>('/api/session/open', { path, force }),

  // Send a prompt. images = array of data URLs (attachments), cwd = for first-time creation of a pending session.
  // model/thinkingLevel = draft selection before the first message (applied when the runtime is created). On 409, ApiError
  prompt: (
    path: string,
    message: string,
    force = false,
    images?: string[],
    cwd?: string,
    draft?: { model?: { provider: string; id: string }; thinkingLevel?: string },
    deliverAs?: 'steer' | 'followUp',
  ) =>
    postJSON<{ accepted: boolean }>('/api/session/prompt', {
      path,
      message,
      force,
      images,
      cwd,
      model: draft?.model,
      thinkingLevel: draft?.thinkingLevel,
      deliverAs,
    }),

  // Replace the queue (individual edit/delete of steering/followUp).
  setQueue: (path: string, steering: string[], followUp: string[]) =>
    postJSON<{ ok: boolean }>('/api/session/queue', { path, steering, followUp }),

  // Abort the in-progress response.
  abort: (path: string) => postJSON<{ aborted: boolean }>('/api/session/abort', { path }),

  // Run a user `!`/`!!` bash command. excludeFromContext = `!!` (output kept out of LLM context).
  // cwd = for first-time creation of a pending session. On 409, ApiError (locked/revoked/busy).
  bash: (path: string, command: string, excludeFromContext = false, cwd?: string, force = false) =>
    postJSON<{ ok: boolean; reason?: string }>('/api/session/bash', {
      path,
      command,
      excludeFromContext,
      cwd,
      force,
    }),

  // UI bridge response (confirm/select/input dialog result).
  uiResponse: (path: string, id: string, value: unknown) =>
    postJSON<{ ok: boolean }>('/api/session/ui-response', { path, id, value }),

  // Delete a session (remove the jsonl). 409 if live/lock-held.
  deleteSession: (path: string) =>
    fetch(apiUrl(`/api/session?path=${encodeURIComponent(path)}`), { method: 'DELETE' }),

  dispose: (path: string) =>
    fetch(apiUrl(`/api/session/live?path=${encodeURIComponent(path)}`), { method: 'DELETE' }),

  // Session control/stats snapshot (info panel). live:false if there's no runtime.
  controls: (path: string) =>
    getJSON<SessionControls>(`/api/session/controls?path=${encodeURIComponent(path)}`),

  // Slash command list (extension + skill). Empty array if there's no live runtime.
  commands: (path: string) =>
    getJSON<{
      commands: { name: string; description?: string; argumentHint?: string; source: string }[];
    }>(`/api/session/commands?path=${encodeURIComponent(path)}`).then((r) => r.commands),

  // Footer data (TUI footer mirroring). Aggregates tokens/cost from the file even without a runtime.
  footer: (path: string, cwd?: string) =>
    getJSON<FooterData>(
      `/api/session/footer?path=${encodeURIComponent(path)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),

  // git status (branch/changed files/commit graph). Read-only.
  git: (cwd: string) => getJSON<GitStatus>(`/api/git?cwd=${encodeURIComponent(cwd)}`),

  // git single commit detail. Read-only.
  gitCommit: (cwd: string, hash: string) =>
    getJSON<GitCommitDetail>(
      `/api/git/commit?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`,
    ),

  // Directory browser (for picking a new session folder). Starts at home if path is omitted.
  fsList: (path?: string) =>
    getJSON<{ path: string; parent: string | null; dirs: string[] }>(
      `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  // Change model. On 409, ApiError.
  setModel: (path: string, provider: string, id: string, force = false) =>
    postJSON<SessionControls>('/api/session/model', { path, provider, id, force }),

  // Change thinking level (efficiency). On 409, ApiError.
  setThinking: (path: string, level: ThinkingLevel, force = false) =>
    postJSON<SessionControls>('/api/session/thinking', { path, level, force }),

  // Rename session. On 409, ApiError.
  rename: (path: string, name: string, force = false) =>
    postJSON<SessionControls>('/api/session/rename', { path, name, force }),

  // Reload extensions/skills. 409 (streaming) if a turn is in progress.
  reload: (path: string, force = false) =>
    postJSON<{ ok: boolean; reason?: string }>('/api/session/reload', { path, force }),
  compact: (path: string, instructions?: string, force = false) =>
    postJSON<{ ok: boolean; reason?: string }>('/api/session/compact', {
      path,
      instructions,
      force,
    }),
};

// ── Event subscription (single WebSocket multiplexing) ────────────────────
// Previously each tab opened its own EventSource (SSE), but with the browser 6-connection limit,
// opening many tabs would stall fetch. Now it multiplexes over event-bus's single WebSocket.
// Call the returned function to unsubscribe.
export function subscribeEvents(path: string, onEvent: (event: any) => void): () => void {
  return subscribePath(path, onEvent);
}
