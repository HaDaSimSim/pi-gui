// pi-web 백엔드 골격.
//
// 보기(목록/스크롤백)는 파일 I/O 로만, 라이브 채팅만 런타임을 띄운다.
// SECURITY: 이 서버는 로컬 셸/파일/모델키에 접근하는 백엔드다.
//   반드시 127.0.0.1 에만 바인딩한다 (외부 노출 = RCE 수준 위험).
//   멀티유저/원격 노출이 필요하면 인증 미들웨어를 먼저 붙여라.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeManager, LockedError, RevokedError } from "./runtime-manager.ts";
import { listLocks } from "../shared/session-lock.ts";

const app = new Hono();
const runtimes = new RuntimeManager();

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

// ── 활성(라이브) 런타임 목록 ──────────────────────────────────────────
app.get("/api/live", (c) => c.json({ live: runtimes.listLive() }));

// ── 락 조망: 지금 누가 무엇을 점유 중인가 (TUI 포함 전체) ──────────────
app.get("/api/locks", (c) => c.json({ locks: listLocks() }));

// ── 사용 가능한 모델 ──────────────────────────────────────────────────
app.get("/api/models", async (c) => {
  const models = await runtimes.available;
  return c.json({
    models: models.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
  });
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
    images?: string[]; // data URL 배열 (data:<mime>;base64,<data>)
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
    // 런타임이 없으면 먼저 띄운다 (락도 여기서 잡힘)
    if (!runtimes.get(body.path)) {
      await runtimes.getOrCreate(body.path, { force: body.force });
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

const PORT = Number(process.env.PORT ?? 4317);
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`pi-web backend → http://127.0.0.1:${info.port}  (localhost only)`);
});

process.on("SIGINT", async () => {
  console.log("\nshutting down…");
  await runtimes.shutdown();
  server.close();
  process.exit(0);
});
