// pi-gui backend skeleton.
//
// Browsing (lists/scrollback) is pure file I/O; only live chat spins up a runtime.
// SECURITY: this server is a backend with access to the local shell/files/model keys.
//   It must bind to 127.0.0.1 only (external exposure = RCE-level risk).
//   If you need multi-user/remote exposure, add auth middleware first.

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';

// Disable the session-lock extension in runtimes spawned by pi-web/pi-gui.
// pi-web already manages SessionLock directly, so if the extension grabs a lock
// on the same file, the two holders conflict and the tool is blocked as "held elsewhere".
// (Must be set before any session is created, so we set it at the top right after imports.)
process.env.PI_WEB_HOST = '1';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { listLocks } from '../shared/session-lock.ts';
import { getCommitDetail, getGitStatus } from './git.ts';
import { preflight } from './preflight.ts';
import { LockedError, RevokedError, RuntimeManager } from './runtime-manager.ts';

const app = new Hono();
const runtimes = new RuntimeManager();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// ── Backend log ring buffer (for the debug UI) ─────────────────────────────────────
// Keeps the last 500 lines in memory. The frontend can read it via /api/log.
const LOG_MAX = 500;
const logBuffer: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
function captureLog(chunk: string | Uint8Array) {
  const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
  for (const line of str.split('\n')) {
    if (line.trim()) {
      logBuffer.push(line);
      if (logBuffer.length > LOG_MAX) logBuffer.shift();
    }
  }
}
process.stdout.write = (...args: any[]) => {
  captureLog(args[0]);
  return origStdoutWrite(...args);
};
process.stderr.write = (...args: any[]) => {
  captureLog(args[0]);
  return origStderrWrite(...args);
};

// ── CORS + origin/Host guard: local-only trust boundary ────────────────────────────
// This backend binds to 127.0.0.1 only, but "binding to 127.0.0.1" alone does not
// stop browser-based local attacks (cross-origin fetch / WebSocket from a malicious
// web page the user visited, and DNS rebinding). So:
//   1) Origin whitelist — tauri://localhost and localhost/127.0.0.1 (any port).
//   2) Host header validation — reject if the request Host is not localhost/127.0.0.1
//      (DNS rebinding defense: even if an attacker domain rebinds to 127.0.0.1, the Host differs).
// The WS upgrade (/ws) is checked with the same isAllowedOrigin (browsers do not apply
// CORS to WS, so we must block it directly).
const ALLOWED_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

function isAllowedOrigin(origin: string | undefined | null): boolean {
  // Absent origin (same-origin navigation, some GETs, Tauri internals) is allowed.
  if (!origin) return true;
  return ALLOWED_ORIGIN.test(origin);
}

// Whether the Host header is a local name (port ignored). The core of the DNS rebinding defense.
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
function isAllowedHost(host: string | undefined | null): boolean {
  if (!host) return false; // HTTP/1.1 requires Host — reject if missing
  return ALLOWED_HOST.test(host);
}

app.use('*', async (c, next) => {
  // Host guard: block rebound external domains. (Our own requests are always localhost/127.0.0.1)
  if (!isAllowedHost(c.req.header('host'))) {
    return c.json({ error: 'forbidden host' }, 403);
  }
  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    // Block cross-origin requests from external origins.
    return c.json({ error: 'forbidden origin' }, 403);
  }
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
});

// ── Directory list (listAll → grouped by cwd): zero runtimes ────────────────────
app.get('/api/directories', async (c) => {
  const all = await SessionManager.listAll();
  const byDir = new Map<string, typeof all>();
  for (const s of all) {
    const key = s.cwd || '(unknown)';
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(s);
  }
  const dirs = [...byDir.entries()]
    .map(([cwd, sessions]) => ({
      cwd,
      sessionCount: sessions.length,
      lastModified: sessions.reduce((max, s) => (s.modified > max ? s.modified : max), new Date(0)),
    }))
    .sort((a, b) => +b.lastModified - +a.lastModified);
  return c.json({ directories: dirs });
});

// ── Session list for one directory: zero runtimes ───────────────────────────────
app.get('/api/sessions', async (c) => {
  const cwd = c.req.query('cwd');
  if (!cwd) return c.json({ error: 'cwd query required' }, 400);
  const sessions = await SessionManager.list(cwd);
  const live = new Set(runtimes.listLive().map((r) => r.key));
  return c.json({
    cwd,
    sessions: sessions
      .map((s) => ({
        path: s.path,
        id: s.id,
        name: s.name ?? null,
        firstMessage: s.firstMessage,
        messageCount: s.messageCount,
        created: s.created,
        modified: s.modified,
        live: live.has(s.path),
      }))
      .sort((a, b) => +new Date(b.modified) - +new Date(a.modified)),
  });
});

// ── Open one session and read messages/tree (scrollback): zero runtimes ──────────────
app.get('/api/session', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  // A pending session with no file yet (new session, before the first prompt) gets empty scrollback.
  if (!existsSync(path)) {
    return c.json({
      path,
      cwd: c.req.query('cwd') ?? '',
      name: null,
      leafId: null,
      entries: [],
      live: !!runtimes.get(path),
      pending: true,
    });
  }
  const sm = SessionManager.open(path);
  const entries = sm.getEntries();
  return c.json({
    path,
    cwd: sm.getCwd(),
    name: sm.getSessionName() ?? null,
    leafId: sm.getLeafId(),
    entries, // rendered by role/type on the frontend
    live: !!runtimes.get(path),
  });
});

// ── Footer info: assembles the same data as the TUI footer (zero runtimes, pure file read).
//   Tokens/cost sum the session's assistant usage. Model/thinking/context are
//   filled from controls if a live runtime exists.
function gitBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const b = out.toString().trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

app.get('/api/session/footer', (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  if (!existsSync(path)) {
    return c.json({
      cwd: c.req.query('cwd') ?? '',
      name: null,
      branch: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      live: false,
    });
  }
  const sm = SessionManager.open(path);
  const cwd = sm.getCwd();
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0;
  for (const e of sm.getEntries()) {
    const msg = (
      e as {
        type: string;
        message?: { role?: string; usage?: Record<string, number> & { cost?: { total?: number } } };
      }
    ).message;
    if (e.type === 'message' && msg?.role === 'assistant' && msg.usage) {
      const u = msg.usage;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
  }
  // Merge model/thinking/context if a live runtime exists
  const controls = runtimes.controls(path);
  return c.json({
    cwd,
    name: sm.getSessionName() ?? null,
    branch: gitBranch(cwd),
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost,
    live: controls.live,
    model: controls.model,
    thinkingLevel: controls.thinkingLevel,
    supportsThinking: controls.supportsThinking,
    contextUsage: (controls.stats as { contextUsage?: unknown } | null)?.contextUsage ?? null,
  });
});

// ── Active (live) runtime list ──────────────────────────────────────────
app.get('/api/live', (c) => c.json({ live: runtimes.listLive() }));

// Preflight: whether pi is installed + required extensions present (read-only).
app.get('/api/preflight', (c) => c.json(preflight()));

// Backend log (for the debug UI). Last-500-line ring buffer.
app.get('/api/log', (c) => c.json({ lines: logBuffer }));

// git status (branch/changed files/commit graph): read-only, zero runtimes.
app.get('/api/git', async (c) => {
  const cwd = c.req.query('cwd');
  if (!cwd) return c.json({ error: 'cwd query required' }, 400);
  return c.json(await getGitStatus(cwd));
});

// git single-commit detail (full message + changed-file numstat): read-only.
app.get('/api/git/commit', async (c) => {
  const cwd = c.req.query('cwd');
  const hash = c.req.query('hash');
  if (!cwd || !hash) return c.json({ error: 'cwd and hash required' }, 400);
  const detail = await getCommitDetail(cwd, hash);
  if (!detail) return c.json({ error: 'commit not found' }, 404);
  return c.json(detail);
});

// Directory browser: lists subdirectories of a given path. Used to pick a new session folder.
// Read-only since it just selects a new directory. Starts at the home directory if path is absent.
app.get('/api/fs/list', async (c) => {
  const raw = c.req.query('path');
  const target = raw?.trim() ? resolve(raw.trim()) : homedir();
  try {
    if (!existsSync(target)) return c.json({ error: 'path not found', path: target }, 404);
    const dirents = await readdir(target, { withFileTypes: true });
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = dirname(target);
    return c.json({
      path: target,
      parent: parent === target ? null : parent, // null at root
      dirs,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), path: target }, 400);
  }
});

// ── Lock overview: who is holding what right now (everything, including the TUI) ──────────────
app.get('/api/locks', (c) => c.json({ locks: listLocks() }));

// ── Available models ──────────────────────────────────────────────────
app.get('/api/models', async (c) => {
  const models = await runtimes.available;
  return c.json({
    models: models.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
  });
});

// ── Mint a new session path: creates a new session file path under the given cwd.
//   Mints only the path, with no runtime/lock (preserves the cost model). The actual file
//   is written on the first prompt (the existing prompt flow). Until then it's a "pending"
//   session that does not appear in lists.
app.post('/api/session/new', async (c) => {
  const body = await c.req.json<{ cwd: string }>();
  const cwd = body?.cwd?.trim();
  if (!cwd) return c.json({ error: 'cwd required' }, 400);
  try {
    const sm = SessionManager.create(cwd);
    const path = sm.getSessionFile();
    if (!path) return c.json({ error: 'could not mint session path' }, 500);
    return c.json({ path, cwd, id: sm.getSessionId(), pending: true });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

// ── Open a live session: grabs the lock (force can take it over) ────────────
app.post('/api/session/open', async (c) => {
  const body = await c.req.json<{ path: string; force?: boolean }>();
  if (!body?.path) return c.json({ error: 'path required' }, 400);
  try {
    await runtimes.getOrCreate(body.path, { force: body.force });
    return c.json({ live: true, locked: true });
  } catch (e) {
    if (e instanceof LockedError) {
      // 409 + current holder info → frontend shows a "force takeover" button
      return c.json({ error: 'locked', current: e.current }, 409);
    }
    throw e;
  }
});

// ── Send a prompt. Verify the lock is mine right before sending ─────────────────
app.post('/api/session/prompt', async (c) => {
  const body = await c.req.json<{
    path: string;
    message: string;
    force?: boolean;
    cwd?: string; // needed when first spinning up a pending session
    images?: string[]; // data URL array (data:<mime>;base64,<data>)
    model?: { provider: string; id: string }; // draft model before the first message
    thinkingLevel?: string; // draft efficiency before the first message
    deliverAs?: 'steer' | 'followUp'; // delivery mode while streaming
  }>();
  if (!body?.path || !body?.message) {
    return c.json({ error: 'path and message required' }, 400);
  }
  // Parse data URL → { type, data, mimeType }. Skip anything that doesn't match the format.
  const images = (body.images ?? [])
    .map((url) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      return m ? { type: 'image' as const, mimeType: m[1], data: m[2] } : null;
    })
    .filter((x): x is { type: 'image'; mimeType: string; data: string } => x !== null);
  try {
    // Spin up the runtime first if absent (the lock is grabbed here too). For a pending session, create it with cwd.
    if (!runtimes.get(body.path)) {
      await runtimes.getOrCreate(body.path, {
        force: body.force,
        cwd: body.cwd,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
    }
    await runtimes.prompt(body.path, body.message, images, body.deliverAs); // re-checks isMine() internally
    return c.json({ accepted: true, live: true });
  } catch (e) {
    if (e instanceof LockedError) {
      return c.json({ error: 'locked', current: e.current }, 409);
    }
    if (e instanceof RevokedError) {
      // someone took the lock right as we tried to send
      return c.json({ error: 'revoked', by: e.by }, 409);
    }
    throw e;
  }
});

// ── Session controls/stats snapshot (for the info panel). live:false when no runtime ──
app.get('/api/session/controls', (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  return c.json(runtimes.controls(path));
});

// ── Abort an in-progress response (lock required, no-op safe) ──
app.post('/api/session/abort', async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body?.path) return c.json({ error: 'path required' }, 400);
  return c.json(await runtimes.abort(body.path));
});

// Replace the queue (steering/followUp) — for editing/deleting individual messages (client sends the surviving list).
app.post('/api/session/queue', async (c) => {
  const body = await c.req.json<{ path: string; steering?: string[]; followUp?: string[] }>();
  if (!body?.path) return c.json({ error: 'path required' }, 400);
  return c.json(runtimes.setQueue(body.path, body.steering ?? [], body.followUp ?? []));
});

// ── UI bridge response: the result of the browser answering a confirm/select/input dialog ──
app.post('/api/session/ui-response', async (c) => {
  const body = await c.req.json<{ path: string; id: string; value: unknown }>();
  if (!body?.path || !body?.id) return c.json({ error: 'path and id required' }, 400);
  const ok = runtimes.respondUi(body.path, body.id, body.value);
  return c.json({ ok });
});

// ── Slash command list (extension-registered). Populated only when a live runtime exists.
app.get('/api/session/commands', (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  return c.json({ commands: runtimes.commands(path) });
});

// ── Change model (lock required) ──
app.post('/api/session/model', async (c) => {
  const body = await c.req.json<{ path: string; provider: string; id: string; force?: boolean }>();
  if (!body?.path || !body?.provider || !body?.id) {
    return c.json({ error: 'path, provider, id required' }, 400);
  }
  try {
    return c.json(await runtimes.setModel(body.path, body.provider, body.id, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: 'locked', current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: 'revoked', by: e.by }, 409);
    throw e;
  }
});

// ── Change thinking level (efficiency) (lock required) ──
app.post('/api/session/thinking', async (c) => {
  const body = await c.req.json<{ path: string; level: string; force?: boolean }>();
  if (!body?.path || !body?.level) return c.json({ error: 'path, level required' }, 400);
  try {
    return c.json(await runtimes.setThinkingLevel(body.path, body.level as never, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: 'locked', current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: 'revoked', by: e.by }, 409);
    throw e;
  }
});

// ── Change session name (lock required — writes the session file) ──
app.post('/api/session/rename', async (c) => {
  const body = await c.req.json<{ path: string; name: string; force?: boolean }>();
  if (!body?.path || typeof body?.name !== 'string') {
    return c.json({ error: 'path, name required' }, 400);
  }
  try {
    return c.json(await runtimes.rename(body.path, body.name, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: 'locked', current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: 'revoked', by: e.by }, 409);
    throw e;
  }
});

// Reload extensions/skills (runtime + lock required). 409 if a turn is in progress.
app.post('/api/session/reload', async (c) => {
  const body = await c.req.json<{ path: string; force?: boolean }>();
  if (!body?.path) return c.json({ error: 'path required' }, 400);
  try {
    const r = await runtimes.reload(body.path, body.force);
    if (!r.ok && r.reason === 'streaming') {
      return c.json({ error: 'streaming', detail: 'cannot reload during a turn' }, 409);
    }
    return c.json(r);
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: 'locked', current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: 'revoked', by: e.by }, 409);
    throw e;
  }
});

// ── SSE: subscribe to one session's live events ─────────────────────────────────
app.get('/api/session/events', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);

  // Attach to the channel only, without a lock/runtime (view/receive only). You can spectate a session someone else is using live.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* closed stream */
        }
      };
      // Send current state once right after connecting: live? + streaming?
      const rt = runtimes.get(path);
      send({ type: '_connected', live: !!rt, streaming: rt?.session.isStreaming ?? false });
      const unsubscribe = runtimes.subscribe(path, send);

      // keepalive ping
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* noop */
        }
      }, 15000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* noop */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// ── WebSocket: one browser = one socket subscribing to many sessions ──────────────────
//   The browser's per-origin HTTP/1.1 6-connection limit does not apply to WS.
//   One socket no matter how many tabs. The set of paths to subscribe is sent over the same socket as {type:"subscribe",paths}.
//   The server wraps events as { path, event } (the frontend routes by path).
app.get(
  '/ws',
  upgradeWebSocket(() => {
    const subs = new Map<string, () => void>(); // path → unsubscribe
    let socket: { send: (data: string) => void } | null = null;
    const sendWrapped = (path: string, event: unknown) => {
      try {
        socket?.send(JSON.stringify({ path, event }));
      } catch {
        /* closed socket */
      }
    };
    const setSubscriptions = (paths: string[]) => {
      const want = new Set(paths);
      for (const [p, unsub] of subs) {
        if (!want.has(p)) {
          unsub();
          subs.delete(p);
        }
      }
      for (const p of want) {
        if (subs.has(p)) continue;
        const rt = runtimes.get(p);
        sendWrapped(p, {
          type: '_connected',
          live: !!rt,
          streaming: rt?.session.isStreaming ?? false,
        });
        const unsub = runtimes.subscribe(p, (event) => sendWrapped(p, event));
        subs.set(p, unsub);
      }
    };
    return {
      onOpen(_evt, ws) {
        socket = ws;
      },
      onMessage(evt, ws) {
        socket = ws;
        let msg: { type?: string; paths?: string[] } | null = null;
        try {
          msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
        } catch {
          return;
        }
        if (msg?.type === 'subscribe') setSubscriptions(Array.isArray(msg.paths) ? msg.paths : []);
      },
      onClose() {
        for (const unsub of subs.values()) unsub();
        subs.clear();
        socket = null;
      },
    };
  }),
);

// ── Tear down a live runtime ─────────────────────────────────────
app.delete('/api/session/live', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  await runtimes.dispose(path);
  return c.json({ disposed: true });
});

// Delete a session (removes the jsonl file). Refuses if live or held by someone else.
app.delete('/api/session', async (c) => {
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path query required' }, 400);
  if (runtimes.get(path)) return c.json({ error: 'session is live; dispose it first' }, 409);
  const holder = listLocks().find((l) => l.sessionPath === path);
  if (holder) return c.json({ error: 'session is locked', current: holder }, 409);
  try {
    if (existsSync(path)) await rm(path);
    return c.json({ deleted: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// PORT defaults to 4317 (dev · the value the Vite proxy expects). Tauri production passes PORT=0
// so the OS picks a free port (avoids collisions). If 0, the actual port is printed in the listen callback below.
const PORT = Number(process.env.PORT ?? 4317);

// ── Production static serving (only when dist-web exists) ────────────────
//   API routes are already handled above. Other paths serve static files from dist-web,
//   falling back to index.html via SPA fallback (for client routing).
//   In dev, Vite serves the frontend so dist-web doesn't exist and this block is skipped.
const DIST_DIR = new URL('../dist-web/', import.meta.url).pathname;
if (existsSync(DIST_DIR)) {
  app.use('/*', serveStatic({ root: './dist-web' }));
  // SPA fallback: non-API unmatched paths return index.html
  const indexHtml = existsSync(`${DIST_DIR}index.html`)
    ? readFileSync(`${DIST_DIR}index.html`, 'utf8')
    : null;
  if (indexHtml) {
    app.get('/*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
      return c.html(indexHtml);
    });
  }
  console.log(`serving static frontend from ${DIST_DIR}`);
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`pi-gui backend → http://127.0.0.1:${info.port}  (localhost only)`);
  // Print the actual port as one machine-readable line so Rust (Tauri) can parse it and inject it into the WebView.
  // (When launched with PORT=0, the OS-chosen port shows up here.)
  console.log(`PI_GUI_PORT=${info.port}`);
});

// Parent-death watchdog (orphan prevention): the backend is always a child of someone
// (dev=node --watch, prod=Rust). If the parent crashes/SIGKILLs instead of exiting cleanly,
// no trap fires and the backend can remain an orphan, holding the port (4317) and running as a zombie.
// It periodically checks the parent PID and self-exits if it's gone. (Disable with PI_GUI_NO_PARENT_WATCH=1)
if (!process.env.PI_GUI_NO_PARENT_WATCH) {
  // Prefer an explicit parent PID; otherwise the ppid at startup.
  const parentPid = Number(process.env.PI_GUI_PARENT_PID) || process.ppid;
  if (parentPid && parentPid > 1) {
    setInterval(() => {
      let alive = true;
      try {
        process.kill(parentPid, 0); // existence check (does not kill)
      } catch (e) {
        alive = (e as NodeJS.ErrnoException)?.code === 'EPERM'; // EPERM = alive
      }
      // ppid changed to 1 = parent died and we were reparented to init.
      if (!alive || process.ppid === 1) {
        console.error('[pi-gui] parent process gone — exiting to avoid orphan.');
        void shutdown('PARENT_GONE');
      }
    }, 2000).unref();
  }
}
// Attach WebSocket (/ws) to the same http.Server's upgrade event.
injectWebSocket(server);

// Safety net: a throw from an extension callback (child-process exit handler, etc.)
// must not kill the backend process. pi-web serves many sessions, so an error in
// one session/extension must not take the whole server down.
// (e.g. the subagents extension mistaking hasUI=true and throwing while touching a TUI-only theme.)
process.on('uncaughtException', (err) => {
  // Don't swallow fatal startup errors like EADDRINUSE — exit immediately.
  // (Otherwise it lingers as a zombie without holding the port, and the next run collides again.)
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EADDRINUSE' || code === 'EACCES') {
    console.error(
      `[pi-gui] fatal startup error(${code}) — exiting. Another backend may already be holding the port.`,
    );
    process.exit(1);
  }
  console.error('[pi-gui] uncaughtException (survived):', err?.stack || err);
  runtimes.broadcastAll({
    type: 'backend_error',
    message: err instanceof Error ? err.message : String(err),
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('[pi-gui] unhandledRejection (survived):', reason);
  runtimes.broadcastAll({
    type: 'backend_error',
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

// Shutdown handling: a single Ctrl-C brings it down reliably.
//  - reentrancy guard (a second signal does not run it twice)
//  - close the listener first to release the port immediately
//  - cleanup must not hang, so force-exit with a timeout
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — shutting down…`);
  server.close();
  // cleanup is best-effort; if it doesn't finish within 2 seconds, exit anyway.
  const cleanup = runtimes.shutdown().catch(() => undefined);
  const timeout = new Promise((r) => setTimeout(r, 2000));
  await Promise.race([cleanup, timeout]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
