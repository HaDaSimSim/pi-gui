// SSE live-streaming E2E.
// Sends a prompt with a real model (relay) and checks end-to-end that text_delta flows over SSE
// and that the lock + runtime mesh together in a real token flow.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`));
};

const dir = mkdtempSync(join(tmpdir(), 'pi-sse-'));
const sessionPath = join(dir, 'sse-session.jsonl');
const header = {
  type: 'session',
  version: 3,
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  cwd: dir,
};
writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);

const post = (path: string, body: unknown) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

try {
  console.log('1) SSE 구독 시작 → _connected 수신');
  const ac = new AbortController();
  const events: any[] = [];
  let textDeltaChars = 0;
  let sawAgentEnd = false;

  const sseDone = (async () => {
    const res = await fetch(`${BASE}/api/session/events?path=${encodeURIComponent(sessionPath)}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    ok(res.status === 200, `SSE 연결 200 (got ${res.status})`);
    ok(
      res.headers.get('content-type')?.includes('text/event-stream') ?? false,
      'content-type event-stream',
    );

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const ev = JSON.parse(dataLine.slice(6));
          events.push(ev);
          if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
            textDeltaChars += ev.assistantMessageEvent.delta.length;
          }
          if (ev.type === 'agent_end') {
            sawAgentEnd = true;
            ac.abort();
            return;
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  // Give SSE a moment to attach
  await new Promise((r) => setTimeout(r, 500));

  console.log('2) 프롬프트 전송 (실제 relay 모델)');
  const pr = await post('/api/session/prompt', {
    path: sessionPath,
    message: 'Say exactly: PIWEB-OK. Nothing else.',
  });
  ok(pr.status === 200, `prompt accepted 200 (got ${pr.status})`);

  // Wait for tokens to flow and for agent_end (up to 30s)
  await Promise.race([sseDone, new Promise((r) => setTimeout(r, 30000))]);
  ac.abort();

  console.log('3) 토큰 흐름 검증');
  ok(
    events.some((e) => e.type === '_connected'),
    '_connected 이벤트 수신',
  );
  ok(
    events.some((e) => e.type === 'agent_start'),
    'agent_start 수신',
  );
  ok(textDeltaChars > 0, `text_delta 누적 ${textDeltaChars}자 수신`);
  ok(sawAgentEnd, 'agent_end 수신 (턴 완료)');

  // Check the actual response text
  const finalText = events
    .filter((e) => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta')
    .map((e) => e.assistantMessageEvent.delta)
    .join('');
  console.log(`   응답: ${JSON.stringify(finalText.slice(0, 80))}`);
  ok(/PIWEB-OK/i.test(finalText), '응답에 PIWEB-OK 포함');

  console.log('4) 세션 파일에 실제로 기록됐는지 (런타임이 jsonl 에 썼나)');
  const sess = await (
    await fetch(`${BASE}/api/session?path=${encodeURIComponent(sessionPath)}`)
  ).json();
  const roles = sess.entries
    .filter((e: any) => e.type === 'message')
    .map((e: any) => e.message.role);
  ok(
    roles.includes('user') && roles.includes('assistant'),
    `user+assistant 기록됨 (roles=${roles.join(',')})`,
  );

  console.log('5) 런타임 내리기');
  const del = await fetch(`${BASE}/api/session/live?path=${encodeURIComponent(sessionPath)}`, {
    method: 'DELETE',
  });
  ok(del.status === 200, 'dispose 200');
  const locksAfter = await (await fetch(`${BASE}/api/locks`)).json();
  ok(!locksAfter.locks.some((l: any) => l.sessionPath === sessionPath), '락 해제됨');
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
