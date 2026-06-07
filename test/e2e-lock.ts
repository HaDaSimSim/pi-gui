// E2E: verify the lock is actually enforced through the server.
// Creates a temporary session jsonl and simulates lock contention via /api/session/open.
// (Verifies only the lock layer without real LLM calls — prompt only checks lock pass/fail)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`));
};

// Create one minimal valid session file (header + 1 user message)
const dir = mkdtempSync(join(tmpdir(), 'pi-e2e-'));
const sessionPath = join(dir, 'e2e-session.jsonl');
const header = {
  type: 'session',
  version: 3,
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  cwd: dir,
};
const msg = {
  type: 'message',
  id: 'aaaa1111',
  parentId: null,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'hello e2e' },
};
writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(msg)}\n`);

const post = (path: string, body: unknown) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

try {
  console.log('1) 세션 열기 → 락 확보');
  {
    const r = await post('/api/session/open', { path: sessionPath });
    ok(r.status === 200, `open 200 (got ${r.status})`);
    const locks = await (await fetch(`${BASE}/api/locks`)).json();
    ok(
      locks.locks.some((l: any) => l.sessionPath === sessionPath && l.owner === 'pi-web'),
      '락 디렉터리에 pi-web 락 등장',
    );
  }

  console.log('2) 같은 런타임 재오픈은 OK (이미 내 것)');
  {
    const r = await post('/api/session/open', { path: sessionPath });
    ok(r.status === 200, `재오픈 200 (got ${r.status})`);
  }

  // Mimic an external holder: overwrite the lock file with a different token to model a "held by someone else" state
  console.log('3) 외부(TUI 흉내)가 락을 가로챈 상태에서 prompt → revoked 거부');
  {
    // A different instance takes over directly via the shared lock module
    const { SessionLock } = await import('../shared/session-lock.ts');
    const intruder = new SessionLock(sessionPath, 'pi', 'TUI-intruder');
    intruder.takeover(); // revoke the pi-web runtime's lock

    const r = await post('/api/session/prompt', {
      path: sessionPath,
      message: 'should be blocked',
    });
    ok(r.status === 409, `prompt 409 (got ${r.status})`);
    const body = await r.json();
    ok(body.error === 'revoked', `error === revoked (got ${body.error})`);
    intruder.release();
  }

  console.log('4) 새 세션 경로를 외부가 먼저 잡으면 open 은 409 locked');
  {
    const sp2 = join(dir, 'e2e-session-2.jsonl');
    writeFileSync(sp2, `${JSON.stringify({ ...header, id: crypto.randomUUID(), cwd: dir })}\n`);
    const { SessionLock } = await import('../shared/session-lock.ts');
    const holder = new SessionLock(sp2, 'pi', 'TUI-holder');
    holder.tryAcquire();

    const r = await post('/api/session/open', { path: sp2 });
    ok(r.status === 409, `open 409 locked (got ${r.status})`);
    const body = await r.json();
    ok(
      body.error === 'locked' && body.current?.owner === 'pi',
      `locked by pi (got ${body.error}/${body.current?.owner})`,
    );

    console.log('5) force=true 로 강제 탈취 → open 성공');
    const r2 = await post('/api/session/open', { path: sp2, force: true });
    ok(r2.status === 200, `force open 200 (got ${r2.status})`);
    ok(holder.isLost(), '기존 점유자(TUI-holder)가 lost 감지');
    holder.release();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
