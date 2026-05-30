// PoC (C): SDK가 pi-web에 필요한 것을 실제로 주는지 실증한다.
//
// 검증 항목:
//   1. SessionManager.listAll() 로 모든 세션을 긁고 cwd(디렉터리)별로 묶을 수 있는가
//   2. 특정 디렉터리의 세션만 list(cwd) 로 뽑을 수 있는가
//   3. 한 세션 파일을 열어 트리/메시지를 읽을 수 있는가 (라이브 스트림 없이도 "보기"가 되는가)
//   4. (옵션) runtime 2개를 동시에 띄워 각각 독립적으로 스트리밍되는가
//
// 4번은 모델 API 키가 있어야 실제 토큰이 흐른다. 키 없으면 자동 skip.

import {
  SessionManager,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(60));

// ── 1. 모든 세션을 긁어서 디렉터리별로 그룹핑 ───────────────────────────
hr();
line("1) SessionManager.listAll() → 디렉터리별 그룹핑");
hr();

const all = await SessionManager.listAll();
line(`전체 세션 수: ${all.length}`);

// cwd 기준으로 묶는다 = opencode web의 "directory 먼저 고르기"가 이걸로 가능
const byDir = new Map();
for (const s of all) {
  const key = s.cwd || "(unknown)";
  if (!byDir.has(key)) byDir.set(key, []);
  byDir.get(key).push(s);
}

line(`디렉터리 수: ${byDir.size}`);
line();
for (const [dir, sessions] of [...byDir.entries()].sort()) {
  line(`📁 ${dir}  (${sessions.length} sessions)`);
  // 최근 수정순 상위 3개만 미리보기
  const recent = [...sessions].sort((a, b) => +b.modified - +a.modified).slice(0, 3);
  for (const s of recent) {
    const title = s.name || s.firstMessage || "(empty)";
    const when = s.modified.toISOString().slice(0, 16).replace("T", " ");
    line(`   • ${when}  [${s.messageCount} msgs]  ${title.slice(0, 50)}`);
  }
  if (sessions.length > 3) line(`   … +${sessions.length - 3} more`);
  line();
}

// ── 2. 특정 디렉터리만 list(cwd) ──────────────────────────────────────
hr();
line("2) SessionManager.list(cwd) → 단일 디렉터리 세션만");
hr();

const firstDir = [...byDir.keys()].find((d) => d !== "(unknown)");
if (firstDir) {
  const scoped = await SessionManager.list(firstDir);
  line(`list("${firstDir}") → ${scoped.length} sessions`);
  line(`listAll 에서 같은 cwd 로 센 값 → ${byDir.get(firstDir).length}`);
  line(scoped.length === byDir.get(firstDir).length ? "✅ 일치" : "⚠️ 불일치 (정렬/필터 차이일 수 있음)");
}
line();

// ── 3. 세션 하나 열어서 트리/메시지 읽기 ──────────────────────────────
hr();
line("3) SessionManager.open(path) → 트리/메시지 읽기 (라이브 없이 보기)");
hr();

// 메시지가 가장 많은 세션을 하나 골라 열어본다
const target = [...all].sort((a, b) => b.messageCount - a.messageCount)[0];
if (target) {
  line(`열 세션: ${target.path}`);
  line(`cwd=${target.cwd}  msgs=${target.messageCount}  name=${target.name ?? "-"}`);
  const sm = SessionManager.open(target.path);
  const entries = sm.getEntries();
  const tree = sm.getTree();
  const path = sm.getBranch(); // 현재 leaf까지의 경로
  line(`entries: ${entries.length}, tree nodes(top): ${Array.isArray(tree) ? tree.length : "?"}, branch len: ${path.length}`);

  // 메시지 몇 개만 역할/미리보기로
  const msgs = entries.filter((e) => e.type === "message").slice(0, 4);
  for (const e of msgs) {
    const role = e.message.role;
    const content =
      typeof e.message.content === "string"
        ? e.message.content
        : JSON.stringify(e.message.content);
    line(`   [${e.id}] ${role}: ${String(content).slice(0, 60).replace(/\n/g, " ")}`);
  }
  line("✅ 라이브 세션 없이도 jsonl 트리/메시지를 읽어 렌더 가능");
}
line();

// ── 4. 모델 키가 있으면 runtime 2개 동시 스트리밍 ─────────────────────
hr();
line("4) (옵션) runtime 2개 동시 스트리밍");
hr();

const auth = AuthStorage.create();
const registry = ModelRegistry.create(auth);
const available = await registry.getAvailable();
line(`사용 가능한(키 있는) 모델 수: ${available.length}`);

if (available.length === 0) {
  line("⚠️ API 키가 없어 라이브 스트리밍 검증은 skip (구조 검증은 1~3에서 끝남)");
} else {
  const { createAgentSession, SessionManager: SM } = await import("@earendil-works/pi-coding-agent");
  const model = available[0];
  line(`사용 모델: ${model.provider}/${model.id}`);

  async function spawnSession(label, prompt) {
    const { session } = await createAgentSession({
      model,
      authStorage: auth,
      modelRegistry: registry,
      sessionManager: SM.inMemory(),
      tools: [], // 순수 텍스트만, 도구 없이 빠르게
    });
    let chars = 0;
    const unsub = session.subscribe((ev) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        chars += ev.assistantMessageEvent.delta.length;
        process.stdout.write(`[${label}]`);
      }
    });
    await session.prompt(prompt);
    unsub();
    session.dispose?.();
    return chars;
  }

  line("두 세션 동시 prompt (인터리빙되면 동시 스트리밍 증명):");
  const [a, b] = await Promise.all([
    spawnSession("A", "Count from 1 to 10, one number per line."),
    spawnSession("B", "List 5 fruits, one per line."),
  ]);
  line();
  line(`✅ A=${a}자, B=${b}자 동시 수신 완료`);
}

hr();
line("PoC 끝.");
