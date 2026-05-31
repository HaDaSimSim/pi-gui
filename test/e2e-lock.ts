// E2E: 서버를 통해 락이 실제로 강제되는지 검증.
// 임시 세션 jsonl 을 만들고, /api/session/open 으로 락 경쟁을 시뮬레이션한다.
// (실제 LLM 호출 없이 락 레이어만 검증 — prompt 는 락 통과 여부만 본다)

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)); };

// 최소 유효 세션 파일 하나 만든다 (header + user 메시지 1개)
const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
const sessionPath = join(dir, "e2e-session.jsonl");
const header = { type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: dir };
const msg = { type: "message", id: "aaaa1111", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello e2e" } };
writeFileSync(sessionPath, JSON.stringify(header) + "\n" + JSON.stringify(msg) + "\n");

const post = (path: string, body: unknown) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  console.log("1) 세션 열기 → 락 확보");
  {
    const r = await post("/api/session/open", { path: sessionPath });
    ok(r.status === 200, `open 200 (got ${r.status})`);
    const locks = await (await fetch(BASE + "/api/locks")).json();
    ok(locks.locks.some((l: any) => l.sessionPath === sessionPath && l.owner === "pi-web"),
       "락 디렉터리에 pi-web 락 등장");
  }

  console.log("2) 같은 런타임 재오픈은 OK (이미 내 것)");
  {
    const r = await post("/api/session/open", { path: sessionPath });
    ok(r.status === 200, `재오픈 200 (got ${r.status})`);
  }

  // 외부 점유자를 흉내내기: 락 파일을 다른 토큰으로 덮어써서 "남이 잡은" 상태 모사
  console.log("3) 외부(TUI 흉내)가 락을 가로챈 상태에서 prompt → revoked 거부");
  {
    // shared 락 모듈로 직접 다른 인스턴스가 takeover
    const { SessionLock } = await import("../shared/session-lock.ts");
    const intruder = new SessionLock(sessionPath, "pi", "TUI-intruder");
    intruder.takeover(); // pi-web 런타임의 락을 revoke 시킴

    const r = await post("/api/session/prompt", { path: sessionPath, message: "should be blocked" });
    ok(r.status === 409, `prompt 409 (got ${r.status})`);
    const body = await r.json();
    ok(body.error === "revoked", `error === revoked (got ${body.error})`);
    intruder.release();
  }

  console.log("4) 새 세션 경로를 외부가 먼저 잡으면 open 은 409 locked");
  {
    const sp2 = join(dir, "e2e-session-2.jsonl");
    writeFileSync(sp2, JSON.stringify({ ...header, id: crypto.randomUUID(), cwd: dir }) + "\n");
    const { SessionLock } = await import("../shared/session-lock.ts");
    const holder = new SessionLock(sp2, "pi", "TUI-holder");
    holder.tryAcquire();

    const r = await post("/api/session/open", { path: sp2 });
    ok(r.status === 409, `open 409 locked (got ${r.status})`);
    const body = await r.json();
    ok(body.error === "locked" && body.current?.owner === "pi", `locked by pi (got ${body.error}/${body.current?.owner})`);

    console.log("5) force=true 로 강제 탈취 → open 성공");
    const r2 = await post("/api/session/open", { path: sp2, force: true });
    ok(r2.status === 200, `force open 200 (got ${r2.status})`);
    ok(holder.isLost(), "기존 점유자(TUI-holder)가 lost 감지");
    holder.release();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
