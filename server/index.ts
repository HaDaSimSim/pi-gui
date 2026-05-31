// pi-gui 백엔드 골격.
//
// 보기(목록/스크롤백)는 파일 I/O 로만, 라이브 채팅만 런타임을 띄운다.
// SECURITY: 이 서버는 로컬 셸/파일/모델키에 접근하는 백엔드다.
//   반드시 127.0.0.1 에만 바인딩한다 (외부 노출 = RCE 수준 위험).
//   멀티유저/원격 노출이 필요하면 인증 미들웨어를 먼저 붙여라.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

// pi-web/pi-gui 가 띄우는 런타임에서는 session-lock 익스텐션을 끕다.
// pi-web 이 이미 SessionLock 을 직접 관리하므로, 익스텐션이 같은 파일에
// 또 락을 잡으면 두 홀더가 충돌해 tool 이 "held elsewhere" 로 차단된다.
// (세션 생성 전에 설정돼야 하므로 import 직후 최상단에서 박는다.)
process.env.PI_WEB_HOST = "1";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeManager, LockedError, RevokedError } from "./runtime-manager.ts";
import { listLocks } from "../shared/session-lock.ts";
import { getGitStatus, getCommitDetail } from "./git.ts";
import { preflight } from "./preflight.ts";

const app = new Hono();
const runtimes = new RuntimeManager();

// ── CORS: 로컬 origin 만 허용 ────────────────────────────────
// Tauri 프로덕션 빌드는 WebView 가 tauri://localhost 에서 로드되어
// 127.0.0.1:4317 로 크로스오리진 요청을 보낸다. 그걸 허용하되,
// 외부 origin 은 차단해 로컬 전용 모델을 유지한다 (외부 노출=RCE 위험).
const ALLOWED_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "content-type");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

// ── 디렉터리 목록 (listAll → cwd 그룹) : 런타임 0개 ────────────────────
app.get("/api/directories", async (c) => {
  const all = await SessionManager.listAll();
  const byDir = new Map<string, typeof all>();
  for (const s of all) {
    const key = s.cwd || "(unknown)";
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(s);
  }
  const dirs = [...byDir.entries()]
    .map(([cwd, sessions]) => ({
      cwd,
      sessionCount: sessions.length,
      lastModified: sessions.reduce(
        (max, s) => (s.modified > max ? s.modified : max),
        new Date(0),
      ),
    }))
    .sort((a, b) => +b.lastModified - +a.lastModified);
  return c.json({ directories: dirs });
});

// ── 한 디렉터리의 세션 목록 : 런타임 0개 ───────────────────────────────
app.get("/api/sessions", async (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd query required" }, 400);
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

// ── 한 세션 열어 메시지/트리 읽기 (스크롤백) : 런타임 0개 ──────────────
app.get("/api/session", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  // 아직 파일이 없는 pending 세션(새 세션, 첫 프롬프트 전)은 빈 스크롤백으로.
  if (!existsSync(path)) {
    return c.json({
      path,
      cwd: c.req.query("cwd") ?? "",
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
    entries, // 프론트에서 role/타입별로 렌더
    live: !!runtimes.get(path),
  });
});

// ── 푸터 정보: TUI 푸터와 같은 데이터를 조립한다 (런타임 0개, 순수 파일 읽기).
//   토큰/비용은 세션의 assistant usage 를 합산. 모델/thinking/context 는
//   라이브 런타임이 있으면 controls 에서 채운다.
function gitBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const b = out.toString().trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

app.get("/api/session/footer", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  if (!existsSync(path)) {
    return c.json({
      cwd: c.req.query("cwd") ?? "",
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
    const msg = (e as { type: string; message?: { role?: string; usage?: Record<string, number> & { cost?: { total?: number } } } }).message;
    if (e.type === "message" && msg?.role === "assistant" && msg.usage) {
      const u = msg.usage;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
  }
  // 라이브 런타임이 있으면 모델/thinking/context 병합
  const controls = runtimes.controls(path);
  return c.json({
    cwd,
    name: sm.getSessionName() ?? null,
    branch: gitBranch(cwd),
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cost,
    live: controls.live,
    model: controls.model,
    thinkingLevel: controls.thinkingLevel,
    supportsThinking: controls.supportsThinking,
    contextUsage: (controls.stats as { contextUsage?: unknown } | null)?.contextUsage ?? null,
  });
});

// ── 활성(라이브) 런타임 목록 ──────────────────────────────────────────
app.get("/api/live", (c) => c.json({ live: runtimes.listLive() }));

// 사전 점검: pi 설치 + 필수 extension 여부 (읽기 전용).
app.get("/api/preflight", (c) => c.json(preflight()));

// git 상태 (브랜치/변경파일/커밋그래프) : 읽기 전용, 런타임 0개.
app.get("/api/git", async (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd query required" }, 400);
  return c.json(await getGitStatus(cwd));
});

// git 단일 커밋 상세 (메시지 전문 + 변경 파일 numstat) : 읽기 전용.
app.get("/api/git/commit", async (c) => {
  const cwd = c.req.query("cwd");
  const hash = c.req.query("hash");
  if (!cwd || !hash) return c.json({ error: "cwd and hash required" }, 400);
  const detail = await getCommitDetail(cwd, hash);
  if (!detail) return c.json({ error: "commit not found" }, 404);
  return c.json(detail);
});

// 디렉터리 브라우저: 주어진 경로의 하위 디렉터리 목록. 새 세션 폴더 선택용.
// 새 디렉터리를 고르는 용도라 읽기 전용. path 없으면 홈 디렉터리에서 시작.
app.get("/api/fs/list", async (c) => {
  const raw = c.req.query("path");
  const target = raw && raw.trim() ? resolve(raw.trim()) : homedir();
  try {
    if (!existsSync(target)) return c.json({ error: "path not found", path: target }, 404);
    const dirents = await readdir(target, { withFileTypes: true });
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = dirname(target);
    return c.json({
      path: target,
      parent: parent === target ? null : parent, // 루트면 null
      dirs,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), path: target }, 400);
  }
});

// ── 락 조망: 지금 누가 무엇을 점유 중인가 (TUI 포함 전체) ──────────────
app.get("/api/locks", (c) => c.json({ locks: listLocks() }));

// ── 사용 가능한 모델 ──────────────────────────────────────────────────
app.get("/api/models", async (c) => {
  const models = await runtimes.available;
  return c.json({
    models: models.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
  });
});

// ── 새 세션 경로 발급: 주어진 cwd 에서 새 세션 파일 경로를 만든다.
//   런타임/락 없이 경로만 발급한다 (비용 모델 유지). 실제 파일은 첫 프롬프트
//   때 쓰여진다(기존 prompt 플로우). 그 전까지는 목록에 안 나타나는 "pending" 세션.
app.post("/api/session/new", async (c) => {
  const body = await c.req.json<{ cwd: string }>();
  const cwd = body?.cwd?.trim();
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    const sm = SessionManager.create(cwd);
    const path = sm.getSessionFile();
    if (!path) return c.json({ error: "could not mint session path" }, 500);
    return c.json({ path, cwd, id: sm.getSessionId(), pending: true });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

// ── 라이브 세션 열기: 락을 잡는다 (force 로 강제 탈취 가능) ────────────
app.post("/api/session/open", async (c) => {
  const body = await c.req.json<{ path: string; force?: boolean }>();
  if (!body?.path) return c.json({ error: "path required" }, 400);
  try {
    await runtimes.getOrCreate(body.path, { force: body.force });
    return c.json({ live: true, locked: true });
  } catch (e) {
    if (e instanceof LockedError) {
      // 409 + 현재 점유자 정보 → 프론트가 "강제로 가져오기" 버튼을 띄운다
      return c.json({ error: "locked", current: e.current }, 409);
    }
    throw e;
  }
});

// ── 프롬프트 전송. 보내기 직전 락이 내 것인지 확인한다 ─────────────────
app.post("/api/session/prompt", async (c) => {
  const body = await c.req.json<{
    path: string;
    message: string;
    force?: boolean;
    cwd?: string; // pending 세션을 처음 띄울 때 필요
    images?: string[]; // data URL 배열 (data:<mime>;base64,<data>)
    model?: { provider: string; id: string }; // 첫 메시지 전 draft 모델
    thinkingLevel?: string; // 첫 메시지 전 draft 효율
  }>();
  if (!body?.path || !body?.message) {
    return c.json({ error: "path and message required" }, 400);
  }
  // data URL → { type, data, mimeType } 로 파싱. 형식 안 맞으면 건너뜀.
  const images = (body.images ?? [])
    .map((url) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      return m ? { type: "image" as const, mimeType: m[1], data: m[2] } : null;
    })
    .filter((x): x is { type: "image"; mimeType: string; data: string } => x !== null);
  try {
    // 런타임이 없으면 먼저 띄운다 (락도 여기서 잡힘). pending 세션이면 cwd 로 생성.
    if (!runtimes.get(body.path)) {
      await runtimes.getOrCreate(body.path, {
        force: body.force,
        cwd: body.cwd,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
    }
    await runtimes.prompt(body.path, body.message, images); // 내부에서 isMine() 재확인
    return c.json({ accepted: true, live: true });
  } catch (e) {
    if (e instanceof LockedError) {
      return c.json({ error: "locked", current: e.current }, 409);
    }
    if (e instanceof RevokedError) {
      // 보내려는 순간 누가 뺏어갔다
      return c.json({ error: "revoked", by: e.by }, 409);
    }
    throw e;
  }
});

// ── 세션 컨트롤/통계 스냅샷 (info 패널용). 런타임 없으면 live:false ──
app.get("/api/session/controls", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  return c.json(runtimes.controls(path));
});

// ── 진행 중인 응답 중단 (락 필요, no-op 안전) ──
app.post("/api/session/abort", async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body?.path) return c.json({ error: "path required" }, 400);
  return c.json(await runtimes.abort(body.path));
});

// ── UI 브릿지 응답: 브라우저가 confirm/select/input 다이얼로그에 답한 결과 ──
app.post("/api/session/ui-response", async (c) => {
  const body = await c.req.json<{ path: string; id: string; value: unknown }>();
  if (!body?.path || !body?.id) return c.json({ error: "path and id required" }, 400);
  const ok = runtimes.respondUi(body.path, body.id, body.value);
  return c.json({ ok });
});

// ── 슬래시 커맨드 목록 (extension 등록). 라이브 런타임 있을 때만 채워짐.
app.get("/api/session/commands", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  return c.json({ commands: runtimes.commands(path) });
});

// ── 모델 변경 (락 필요) ──
app.post("/api/session/model", async (c) => {
  const body = await c.req.json<{ path: string; provider: string; id: string; force?: boolean }>();
  if (!body?.path || !body?.provider || !body?.id) {
    return c.json({ error: "path, provider, id required" }, 400);
  }
  try {
    return c.json(await runtimes.setModel(body.path, body.provider, body.id, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: "locked", current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: "revoked", by: e.by }, 409);
    throw e;
  }
});

// ── 사고 수준(efficiency) 변경 (락 필요) ──
app.post("/api/session/thinking", async (c) => {
  const body = await c.req.json<{ path: string; level: string; force?: boolean }>();
  if (!body?.path || !body?.level) return c.json({ error: "path, level required" }, 400);
  try {
    return c.json(await runtimes.setThinkingLevel(body.path, body.level as never, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: "locked", current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: "revoked", by: e.by }, 409);
    throw e;
  }
});

// ── 세션 이름 변경 (락 필요 — 세션 파일 쓰기) ──
app.post("/api/session/rename", async (c) => {
  const body = await c.req.json<{ path: string; name: string; force?: boolean }>();
  if (!body?.path || typeof body?.name !== "string") {
    return c.json({ error: "path, name required" }, 400);
  }
  try {
    return c.json(await runtimes.rename(body.path, body.name, body.force));
  } catch (e) {
    if (e instanceof LockedError) return c.json({ error: "locked", current: e.current }, 409);
    if (e instanceof RevokedError) return c.json({ error: "revoked", by: e.by }, 409);
    throw e;
  }
});

// ── SSE: 한 세션의 라이브 이벤트 구독 ─────────────────────────────────
app.get("/api/session/events", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);

  // 락/런타임 없이 채널에만 붙는다 (보기/수신 전용). 남이 라이브로 쓰는 세션도 관전 가능.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* 닫힌 스트림 */
        }
      };
      // 연결 직후 현재 상태 한 번: 라이브 여부 + 스트리밍 여부
      const rt = runtimes.get(path);
      send({ type: "_connected", live: !!rt, streaming: rt?.session.isStreaming ?? false });
      const unsubscribe = runtimes.subscribe(path, send);

      // keepalive ping
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* noop */
        }
      }, 15000);

      c.req.raw.signal.addEventListener("abort", () => {
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
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── 라이브 런타임 내리기 ──────────────────────────────────────────────
app.delete("/api/session/live", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  await runtimes.dispose(path);
  return c.json({ disposed: true });
});

// 세션 삭제 (jsonl 파일 제거). 라이브이거나 남이 점유 중이면 거부.
app.delete("/api/session", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  if (runtimes.get(path)) return c.json({ error: "session is live; dispose it first" }, 409);
  const holder = listLocks().find((l) => l.sessionPath === path);
  if (holder) return c.json({ error: "session is locked", current: holder }, 409);
  try {
    if (existsSync(path)) await rm(path);
    return c.json({ deleted: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// PORT 미지정 시 4317 (dev · Vite 프록시 기대값). Tauri 프로덕션은 PORT=0 을 넘겨
// OS 가 빈 포트를 고르게 한다(충돌 회피). 0 이면 아래 listen 콜백에서 실제 포트를 찍는다.
const PORT = Number(process.env.PORT ?? 4317);

// ── 프로덕션 정적 서빙 (dist-web 가 있을 때만) ────────────────
//   API 라우트는 위에서 이미 처리됨. 그 외 경로는 dist-web 의 정적 파일,
//   없으면 SPA fallback 으로 index.html (클라이언트 라우팅용).
//   dev 에서는 Vite 가 프론트를 띄우므로 dist-web 이 없고, 이 블록은 스킵된다.
const DIST_DIR = new URL("../dist-web/", import.meta.url).pathname;
if (existsSync(DIST_DIR)) {
  app.use("/*", serveStatic({ root: "./dist-web" }));
  // SPA fallback: API 가 아닌 미매칭 경로는 index.html
  const indexHtml = existsSync(`${DIST_DIR}index.html`)
    ? readFileSync(`${DIST_DIR}index.html`, "utf8")
    : null;
  if (indexHtml) {
    app.get("/*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
      return c.html(indexHtml);
    });
  }
  console.log(`serving static frontend from ${DIST_DIR}`);
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`pi-gui backend → http://127.0.0.1:${info.port}  (localhost only)`);
  // Rust(Tauri) 가 파싱해 WebView 에 주입할 수 있게 실제 포트를 기계가독 한 줄로 출력.
  // (PORT=0 으로 띄우면 OS 가 고른 포트가 여기 찍힌다.)
  console.log(`PI_GUI_PORT=${info.port}`);
});

// 안전망: extension 콜백(자식 프로세스 exit 핸들러 등)에서 throw 가 나도
// 백엔드 프로세스를 죽이지 않는다. pi-web 은 다수 세션을 서빙하므로
// 한 세션/익스텐션의 오류가 서버 전체를 내리면 안 된다.
// (예: subagents 익스텐션이 hasUI=true 로 착각해 TUI 전용 theme 을 건드리다 throw.)
process.on("uncaughtException", (err) => {
  console.error("[pi-gui] uncaughtException (생존):", err?.stack || err);
  runtimes.broadcastAll({
    type: "backend_error",
    message: err instanceof Error ? err.message : String(err),
  });
});
process.on("unhandledRejection", (reason) => {
  console.error("[pi-gui] unhandledRejection (생존):", reason);
  runtimes.broadcastAll({
    type: "backend_error",
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

// 종료 처리: Ctrl-C 한 번에 확실히 내려간다.
//  - 재진입 방지(두 번째 시그널이 와도 중복 실행 안 함)
//  - 리스너를 먼저 닫아 포트를 바로 반납
//  - cleanup 이 멈추면 안 되므로 타임아웃으로 강제 종료
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — shutting down…`);
  server.close();
  // cleanup 은 최선, 단 2초 안에 끝나지 않으면 그대로 종료.
  const cleanup = runtimes.shutdown().catch(() => undefined);
  const timeout = new Promise((r) => setTimeout(r, 2000));
  await Promise.race([cleanup, timeout]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
