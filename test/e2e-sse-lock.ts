// SSE lock-conflict resolution verification.
// Claim: even if someone else holds the lock, an SSE subscription isn't rejected (viewing is lock-free).
//   - external (mimicking TUI) holds the lock → SSE-subscribe that session on pi-web → 200 + _connected
//   - prompt is still blocked by the lock (writes are exclusive only)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLock } from '../shared/session-lock.ts';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`));
};

const dir = mkdtempSync(join(tmpdir(), 'pi-sselock-'));
const sessionPath = join(dir, 's.jsonl');
writeFileSync(
  sessionPath,
  `${JSON.stringify({
    type: 'session',
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: dir,
  })}\n`,
);

const post = (p: string, b: unknown) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

try {
  console.log('1) 외부(TUI 흉내)가 먼저 락을 점유');
  const intruder = new SessionLock(sessionPath, 'pi', 'TUI-holder');
  ok(intruder.tryAcquire().acquired, '외부 락 확보');

  console.log('2) 그 세션에 SSE 구독 → 락 있어도 거부 안 됨');
  const ac = new AbortController();
  let connected = false;
  let connectedLive: boolean | undefined;
  const sse = (async () => {
    const res = await fetch(`${BASE}/api/session/events?path=${encodeURIComponent(sessionPath)}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    ok(res.status === 200, `SSE 200 (락 점유 중에도) (got ${res.status})`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dl) continue;
          const ev = JSON.parse(dl.slice(6));
          if (ev.type === '_connected') {
            connected = true;
            connectedLive = ev.live;
            ac.abort();
            return;
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await Promise.race([sse, new Promise((r) => setTimeout(r, 5000))]);
  ac.abort();
  ok(connected, '_connected 수신 (구독 성공)');
  ok(connectedLive === false, `live=false (pi-web 런타임 아직 없음) (got ${connectedLive})`);

  console.log('3) 하지만 prompt 는 락 때문에 막힌다 (쓰기는 배타)');
  const pr = await post('/api/session/prompt', { path: sessionPath, message: 'should be blocked' });
  ok(pr.status === 409, `prompt 409 locked (got ${pr.status})`);
  const body = await pr.json();
  ok(body.error === 'locked', `error=locked (got ${body.error})`);

  console.log('4) 외부가 락 풀면 prompt 가능 (정리)');
  intruder.release();
  ok(!intruder.isMine(), '외부 락 해제됨');

  // Cleanup: tear down any runtime that may have come up
  await fetch(`${BASE}/api/session/live?path=${encodeURIComponent(sessionPath)}`, {
    method: 'DELETE',
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
