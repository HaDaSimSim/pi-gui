// WebSocket live-streaming E2E.
// Events are now multiplexed over a single WebSocket (/ws). It sends a prompt with a real
// model (relay) and checks that { path, event } flows over WS + that one socket routes multiple paths.
//
// Key regression guard: it must be "multiplex over 1 socket", not "one connection per tab (=path)".

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
const WS_BASE = BASE.replace(/^http/, 'ws');
let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`));
};

const dir = mkdtempSync(join(tmpdir(), 'pi-ws-'));
const mkSession = (name: string) => {
  const p = join(dir, name);
  const header = {
    type: 'session',
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: dir,
  };
  writeFileSync(p, `${JSON.stringify(header)}\n`);
  return p;
};
const sessionPath = mkSession('ws-session.jsonl');
const otherPath = mkSession('ws-other.jsonl');

const post = (path: string, body: unknown) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// Collect received events per path.
const byPath = new Map<string, any[]>();
const recordEvent = (wrapped: any) => {
  if (!wrapped || typeof wrapped.path !== 'string') return;
  if (!byPath.has(wrapped.path)) byPath.set(wrapped.path, []);
  byPath.get(wrapped.path)!.push(wrapped.event);
};

try {
  console.log('1) WebSocket 연결 + 두 세션 구독 (소켓 1개로 멀티플렉싱)');
  const ws = new WebSocket(`${WS_BASE}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  }).catch((e) => ok(false, `WS open: ${e.message}`));
  ok(ws.readyState === WebSocket.OPEN, 'WS 연결 열림');

  let textDeltaChars = 0;
  let sawAgentEnd = false;
  ws.addEventListener('message', (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    recordEvent(msg);
    if (msg.path === sessionPath) {
      const e = msg.event;
      if (e?.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
        textDeltaChars += e.assistantMessageEvent.delta.length;
      }
      if (e?.type === 'agent_end') sawAgentEnd = true;
    }
  });

  // Subscribe to both paths over one socket.
  ws.send(JSON.stringify({ type: 'subscribe', paths: [sessionPath, otherPath] }));

  // _connected must arrive for both paths.
  await new Promise((r) => setTimeout(r, 600));
  ok(
    (byPath.get(sessionPath) ?? []).some((e) => e.type === '_connected'),
    'session path _connected 수신',
  );
  ok(
    (byPath.get(otherPath) ?? []).some((e) => e.type === '_connected'),
    'other path _connected 수신 (멀티플렉싱)',
  );

  console.log('2) 프롬프트 전송 (실제 relay 모델) — session path 로만');
  const pr = await post('/api/session/prompt', {
    path: sessionPath,
    message: 'Say exactly: PIWEB-OK. Nothing else.',
  });
  ok(pr.status === 200, `prompt accepted 200 (got ${pr.status})`);

  await new Promise((r) => setTimeout(r, 200)); // time for streaming to attach right after prompt
  // Poll until agent_end (up to 30s)
  const deadline = Date.now() + 30000;
  while (!sawAgentEnd && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('3) 토큰 흐름 검증 (session path)');
  const sEvents = byPath.get(sessionPath) ?? [];
  ok(
    sEvents.some((e) => e.type === 'agent_start'),
    'agent_start 수신',
  );
  ok(textDeltaChars > 0, `text_delta 누적 ${textDeltaChars}자 수신`);
  ok(sawAgentEnd, 'agent_end 수신 (턴 완료)');

  const finalText = sEvents
    .filter((e) => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta')
    .map((e) => e.assistantMessageEvent.delta)
    .join('');
  console.log(`   응답: ${JSON.stringify(finalText.slice(0, 80))}`);
  ok(/PIWEB-OK/i.test(finalText), '응답에 PIWEB-OK 포함');

  console.log('4) 라우팅 격리 — other path 로는 토큰이 새지 않았는지');
  const oEvents = byPath.get(otherPath) ?? [];
  ok(
    !oEvents.some((e) => e.type === 'agent_start' || e.type === 'message_update'),
    'other path 엔 프롬프트 이벤트 안 샘',
  );

  console.log('5) 구독 해제 (other path) 후에도 소켓 유지');
  ws.send(JSON.stringify({ type: 'subscribe', paths: [sessionPath] }));
  await new Promise((r) => setTimeout(r, 300));
  ok(ws.readyState === WebSocket.OPEN, '구독 변경 후에도 소켓 열림');

  console.log('6) 세션 파일 기록 확인');
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

  console.log('7) 런타임 내리기 + 락 해제');
  const del = await fetch(`${BASE}/api/session/live?path=${encodeURIComponent(sessionPath)}`, {
    method: 'DELETE',
  });
  ok(del.status === 200, 'dispose 200');
  const locksAfter = await (await fetch(`${BASE}/api/locks`)).json();
  ok(!locksAfter.locks.some((l: any) => l.sessionPath === sessionPath), '락 해제됨');

  ws.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
