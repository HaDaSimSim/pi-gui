// PoC (C): demonstrates that the SDK actually provides what pi-web needs.
//
// Items verified:
//   1. Can SessionManager.listAll() scrape all sessions and group them by cwd (directory)
//   2. Can list(cwd) pull only the sessions of a specific directory
//   3. Can we open one session file and read its tree/messages (does "viewing" work without a live stream)
//   4. (optional) Can two runtimes run at once and stream independently
//
// #4 needs a model API key for real tokens to flow. Auto-skipped without a key.

import { AuthStorage, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent';

const line = (s = '') => console.log(s);
const hr = () => line('─'.repeat(60));

// ── 1. Scrape all sessions and group them by directory ───────────────────────────
hr();
line('1) SessionManager.listAll() → 디렉터리별 그룹핑');
hr();

const all = await SessionManager.listAll();
line(`전체 세션 수: ${all.length}`);

// Group by cwd = enables opencode web's "pick a directory first"
const byDir = new Map();
for (const s of all) {
  const key = s.cwd || '(unknown)';
  if (!byDir.has(key)) byDir.set(key, []);
  byDir.get(key).push(s);
}

line(`디렉터리 수: ${byDir.size}`);
line();
for (const [dir, sessions] of [...byDir.entries()].sort()) {
  line(`📁 ${dir}  (${sessions.length} sessions)`);
  // Preview only the top 3 most recently modified
  const recent = [...sessions].sort((a, b) => +b.modified - +a.modified).slice(0, 3);
  for (const s of recent) {
    const title = s.name || s.firstMessage || '(empty)';
    const when = s.modified.toISOString().slice(0, 16).replace('T', ' ');
    line(`   • ${when}  [${s.messageCount} msgs]  ${title.slice(0, 50)}`);
  }
  if (sessions.length > 3) line(`   … +${sessions.length - 3} more`);
  line();
}

// ── 2. list(cwd) for a specific directory ──────────────────────────────────────
hr();
line('2) SessionManager.list(cwd) → 단일 디렉터리 세션만');
hr();

const firstDir = [...byDir.keys()].find((d) => d !== '(unknown)');
if (firstDir) {
  const scoped = await SessionManager.list(firstDir);
  line(`list("${firstDir}") → ${scoped.length} sessions`);
  line(`listAll 에서 같은 cwd 로 센 값 → ${byDir.get(firstDir).length}`);
  line(
    scoped.length === byDir.get(firstDir).length
      ? '✅ 일치'
      : '⚠️ 불일치 (정렬/필터 차이일 수 있음)',
  );
}
line();

// ── 3. Open one session and read its tree/messages ─────────────────────────────
hr();
line('3) SessionManager.open(path) → 트리/메시지 읽기 (라이브 없이 보기)');
hr();

// Pick and open the session with the most messages
const target = [...all].sort((a, b) => b.messageCount - a.messageCount)[0];
if (target) {
  line(`열 세션: ${target.path}`);
  line(`cwd=${target.cwd}  msgs=${target.messageCount}  name=${target.name ?? '-'}`);
  const sm = SessionManager.open(target.path);
  const entries = sm.getEntries();
  const tree = sm.getTree();
  const path = sm.getBranch(); // path up to the current leaf
  line(
    `entries: ${entries.length}, tree nodes(top): ${Array.isArray(tree) ? tree.length : '?'}, branch len: ${path.length}`,
  );

  // A few messages, by role/preview
  const msgs = entries.filter((e) => e.type === 'message').slice(0, 4);
  for (const e of msgs) {
    const role = e.message.role;
    const content =
      typeof e.message.content === 'string' ? e.message.content : JSON.stringify(e.message.content);
    line(`   [${e.id}] ${role}: ${String(content).slice(0, 60).replace(/\n/g, ' ')}`);
  }
  line('✅ 라이브 세션 없이도 jsonl 트리/메시지를 읽어 렌더 가능');
}
line();

// ── 4. If a model key exists, stream two runtimes at once ─────────────────
hr();
line('4) (옵션) runtime 2개 동시 스트리밍');
hr();

const auth = AuthStorage.create();
const registry = ModelRegistry.create(auth);
const available = await registry.getAvailable();
line(`사용 가능한(키 있는) 모델 수: ${available.length}`);

if (available.length === 0) {
  line('⚠️ API 키가 없어 라이브 스트리밍 검증은 skip (구조 검증은 1~3에서 끝남)');
} else {
  const { createAgentSession, SessionManager: SM } = await import(
    '@earendil-works/pi-coding-agent'
  );
  const model = available[0];
  line(`사용 모델: ${model.provider}/${model.id}`);

  async function spawnSession(label, prompt) {
    const { session } = await createAgentSession({
      model,
      authStorage: auth,
      modelRegistry: registry,
      sessionManager: SM.inMemory(),
      tools: [], // pure text only, fast with no tools
    });
    let chars = 0;
    const unsub = session.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
        chars += ev.assistantMessageEvent.delta.length;
        process.stdout.write(`[${label}]`);
      }
    });
    await session.prompt(prompt);
    unsub();
    session.dispose?.();
    return chars;
  }

  line('두 세션 동시 prompt (인터리빙되면 동시 스트리밍 증명):');
  const [a, b] = await Promise.all([
    spawnSession('A', 'Count from 1 to 10, one number per line.'),
    spawnSession('B', 'List 5 fruits, one per line.'),
  ]);
  line();
  line(`✅ A=${a}자, B=${b}자 동시 수신 완료`);
}

hr();
line('PoC 끝.');
