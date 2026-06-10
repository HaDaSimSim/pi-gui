# Handoff — pi-gui → SwiftUI 네이티브 재작성 (RPC 기반)

작성: 2026-06-10. 이 문서는 직전 세션의 결론을 새 세션으로 넘기기 위한 핸드오프다.
목표: **내가 유지보수하는 Node 백엔드(`server/`)를 버리고**, pi를 `--mode rpc`로 직접
호스팅하는 **SwiftUI macOS 네이티브 앱**으로 재작성한다. 새 브랜치에서 진행.

> **갱신(2026-06-10 세션 2):** §5의 PoC 1·2·3을 전부 실행해 통과시켰다. RPC 호스팅
> 방식이 검증됨. 결과는 아래 **§A. PoC 결과(검증 완료)** 참조. `web/`도 전부 버리고
> SwiftUI로 간다(사용자 확정). 다음 작업은 새 브랜치 생성 + 트랙 1(Browsing) 착수.

---

## 0. 결정된 방향 (확정)

- **macOS 전용** SwiftUI 네이티브 앱으로 간다. (크로스플랫폼 포기 — 사용자 OK)
- **Node 백엔드(`server/`, 우리 코드 ~3,100줄)는 버린다.**
- pi 런타임 자체는 Node로 남지만 그건 **우리 코드가 아니라 설치된 도구**(`pi` 바이너리).
  Swift는 SDK를 import하지 않고 `pi --mode rpc`를 자식 프로세스로 spawn해 JSONL로 통신한다.
- **pi 업데이트 금지. 앱(`/Applications/pi.app`) 부팅 금지.** (사용자 지시)
- 기존 React/Tauri/Node 스택은 새 브랜치에서 단계적으로 들어낸다. main은 당분간 유지.

### 환경 (검증됨)
- `pi`: `/Users/mingeon/.nvm/versions/node/v24.14.0/bin/pi`, v0.78.1, `--mode rpc` 지원 확인.
- Swift 6.3.2 (Apple), Target arm64-apple-macosx26.0 — `/usr/bin/swift` 있음.
- `~/.pi/agent/models.json` 존재. 기본 모델 relay/claude-opus-4.8 (RPC get_state로 확인).
- **PoC/검증에서 relay/ 계열 모델은 뭐든 써도 됨** (사용자 OK). `pi --mode rpc --model relay/<id>` 로 지정 가능.

---

## 1. 직전 세션에서 발생/해결한 일 (OOM 인시던트)

### 증상
빌드된 `/Applications/pi.app`이 부팅 시 DevTools에 "could not connect to server".
백엔드(Node child)가 spawn 직후 죽음.

### 근본 원인 (확정)
- 앱 종료 시 열린 탭을 localStorage `pi-gui.open-tabs`에 저장 → 재시작 때 복원.
- 복원하면서 각 탭이 `/api/session` 호출 → `sm.getEntries()`가 jsonl **전체**를 파싱하고
  `c.json({ entries })`로 통째 직렬화(163~176M 세션이면 응답만 ~171MB).
- 거대 세션(225M/176M) 여러 개가 동시에 로드되어 **V8 기본 힙(~4.3GB) 초과 → OOM 크래시**.
- backend.log 스택: `node::fs::AfterInteger` → `StringDecoder::DecodeData`,
  `Mark-Compact 4044MB` → `FATAL ERROR: Reached heap limit`.

### 적용한 즉시 복구 (코드 변경 없음)
열린 탭 5개 중 176M짜리 `tokyo-harness ...019ea71f` 하나만 범인. localStorage에서 그것만 제거.

- localStorage 물리 경로(prod 앱, origin `tauri://localhost`):
  ```
  ~/Library/WebKit/me.mingeon.pi-gui/WebsiteData/Default/fFNVCfgFdachlFxSLnwwOlyfPijL706ke5Wrh42IVe4/fFNVCfgFdachlFxSLnwwOlyfPijL706ke5Wrh42IVe4/LocalStorage/localstorage.sqlite3
  ```
  값은 **UTF-16LE BLOB**으로 저장됨(주의: sqlite3 CLI로 TEXT 쓰면 WebKit이 오독).
- `localstorage.sqlite3{,-wal,-shm}` 백업본을 `.bak`로 남겨둠 (같은 디렉토리).
- 거대 탭만 제거하고 나머지 4개 탭 유지. tokyo-harness **세션 파일 자체는 안 건드림**(다시 열 수 있음, 단 직접 열면 무거움).
- **주의: 직전 세션 막판에 사용자가 "앱 부팅시키지마"라고 했다. 검증용으로 한 번 `open -a`
  해서 정상 부팅(포트 56257)까지 확인은 끝난 상태. 추가로 다시 띄우지 말 것.**

### 현행 Node 백엔드의 진짜 버그 (SwiftUI로 가면 자연 소멸하지만 기록)
`server/index.ts` `/api/session`(라인 ~173)과 `/api/session/footer`(라인 ~217)가
`sm.getEntries()`로 파일 전체를 메모리에 올린다. 스크롤백은 프론트에서 **선형 렌더**
(`web/use-session.ts` `entriesToMessages`, parentId 트리 안 따라감)라서, 끝 N개만 읽어도
표시는 멀쩡하다. → tail 파싱이 의미적으로 정당. SwiftUI 안에서는 트랙 1이 이걸 태생적으로 해결.

---

## 2. SDK 의존면 조사 결론 (서브에이전트 전수조사)

**SDK import는 단 두 파일에만 있다:**
- `server/index.ts:33` — `SessionManager`만.
- `server/runtime-manager.ts:16-23` — `AgentSession`(타입), `AuthStorage`, `createAgentSession`,
  `DefaultResourceLoader`, `getAgentDir`, `ModelRegistry`, `SessionManager`, `SettingsManager`.
- 나머지 8개 파일 + `shared/session-lock.ts`는 **SDK 무관**(node:fs/child_process/crypto + Hono).

**(a) Swift로 재구현 가능 (순수 파일 I/O):**
- `SessionManager.listAll/list/open/getEntries/getCwd/getSessionName/getLeafId`.
  - 파서가 trivial: `content.trim().split("\n")` 후 줄마다 `JSON.parse`, 깨진 줄 skip.
  - 세션 디렉토리 규칙: `~/.pi/agent/sessions/--<cwd의 / 를 - 로 치환>--/*.jsonl`.
  - 첫 줄 = `{"type":"session","version":3,...}`, 이후 message/model_change/custom 등.
- footer 토큰/비용 집계 = 엔트리 순회 산수.
- `git.ts`(git CLI), `preflight.ts`, `restore-path.ts`, `tailscale.ts`, `remote-*.ts`,
  `shared/session-lock.ts` — 전부 Swift 포팅 가능.

**(b) SDK 없이는 불가능 (= RPC로 위임할 부분):**
- `createAgentSession()`가 반환하는 `AgentSession`의 모든 것:
  prompt/steer/followUp/executeBash/abort/setModel/setThinkingLevel/setSessionName/
  reload/compact/subscribe(이벤트 스트림)/bindExtensions(UI 브릿지)/getSessionStats.
- 즉 LLM 호출, 툴 실행(read/bash/edit/write), 확장 시스템 전체, 시스템 프롬프트 빌드, compaction.
- 이건 에이전트 **실행 엔진**이라 재구현 불가 → **`pi --mode rpc`가 그대로 제공**한다.

**코드 비중:** browsing/파일 경로 ~55-60%, runtime 경로 ~40-45%.
→ browsing은 Swift로, runtime은 RPC 프로세스로. 깔끔하게 갈린다.

---

## 3. RPC PoC 결과 (직전 세션에서 실제 실행, 검증됨)

명령: `printf '<jsonl>' | pi --mode rpc --no-session`

확인된 사실:
- ✅ `get_state` → 모델 객체(relay/claude-opus-4.8, contextWindow 200000 등) + isStreaming/
  thinkingLevel/sessionId/messageCount 정상 반환.
- ✅ `get_commands` → btw/goal/takeover/stats/todo + skill:* 전부 나옴(소스 경로 포함).
- ✅ **시작 직후 `extension_ui_request`가 쏟아짐**: setStatus(async-bash/goal/subagents/todo),
  setWidget(todo-progress). → **todo/goal/subagents/session-lock 확장이 RPC 모드에서도 살아있다.**
  이게 SwiftUI 안의 핵심 호재: 확장 생태계를 그대로 받는다.
- LLM 실제 호출(prompt→스트리밍 이벤트)까지는 아직 PoC 안 함 — **새 세션에서 다음 할 일**.

### RPC 프로토콜 주의점 (문서 `docs/rpc.md` 기준)
- **프레이밍: LF(`\n`)만 레코드 구분.** `\r\n` 입력은 trailing `\r` strip. **U+2028/U+2029를
  newline으로 취급 금지**(JSON 문자열 안에 들어갈 수 있음). Node `readline` 부적합 — 직접 버퍼 분할.
- 세션 1개 = 프로세스 1개. 멀티탭이면 `pi --mode rpc` 프로세스를 N개 관리(Swift 책임).
- streaming 중 prompt는 `streamingBehavior: "steer"|"followUp"` 필수.
- 확장 UI: dialog(select/confirm/input/editor)는 `extension_ui_request`(stdout) → 클라가
  `extension_ui_response`(stdin, 같은 id)로 응답. notify/setStatus/setWidget/setTitle은 fire-and-forget.
- `ctx.mode === "rpc"`, `ctx.hasUI === true`. **`custom()`은 RPC에서 `undefined`**,
  setFooter/setHeader/setWorkingMessage 등은 no-op.
- 세션 영구저장 켜려면 `--no-session` 빼면 됨. `--session-dir`로 커스텀 경로 가능.

---

## 4. SwiftUI 네이티브 아키텍처

```
SwiftUI 앱 (호스트, macOS)
  ├─ Browsing: 세션 jsonl 직접 읽기 + tail 파싱 (Swift Codable)  ← OOM 태생적 해결
  ├─ Lock: shared/session-lock.ts 프로토콜 Swift 포팅 (fs + crypto)
  └─ Runtime: 세션당 `pi --mode rpc` 프로세스 spawn, stdin/stdout JSONL 파이프
       └ pi 바이너리 = 에이전트 엔진 (우리 코드 아님)
```

### 작업 트랙
**트랙 1 — Browsing (Swift, 난이도 낮음, OOM 해결 포함)**
- jsonl 파서(Codable), 세션 목록/디렉토리/footer 집계. **tail N개만 읽기**로 거대 세션 안전.
- 스크롤백은 선형 렌더라 tail로 충분. "위로 더 불러오기"는 후속.

**트랙 2 — Lock 프로토콜 (Swift 포팅, 정밀)**
- `shared/session-lock.ts`(SDK 아님, fs+crypto). **pi TUI와 byte-identical 필수**(AGENTS.md 하드룰).
- owner 문자열 `"pi-web"` **그대로 유지**(프로토콜 식별자, 바꾸면 TUI와 호환 깨짐).
- 소스 오브 트루스는 `vendor/pi-skills/extensions/session-lock/shared/session-lock.ts`(서브모듈).

**트랙 3 — RPC 런타임 호스팅 (Swift Process + Pipe)**
- 세션당 `pi --mode rpc [--session-dir ...]` spawn. LF-only 프레이밍 직접 구현.
- prompt/steer/followUp/abort/set_model/set_thinking_level/compact/get_session_stats 매핑.
- 이벤트 스트림(agent_start/turn_*/message_update/tool_execution_*/queue_update 등) → SwiftUI 상태.
- 멀티 프로세스 lifecycle/메모리 관리.

**트랙 4 — UI 브릿지 (RPC extension_ui 서브프로토콜)**
- confirm/select/input/editor → SwiftUI 다이얼로그. notify/setStatus/setWidget → 네이티브 표시.
- **questionnaire/btw 확인 필요**: 현재 pi-skills 확장이 `PI_WEB_HOST` 감지해서 커스텀 메서드
  호출(`web-ui-context.ts`). RPC 모드에서 이게 어떻게 나오는지 PoC로 확인. 네이티브용 새 신호가
  필요할 수 있음(= pi-skills 변경, 스코프 갈림).
- `ctx.ui.custom()`은 RPC에서 undefined → subagents 뷰어 등은 네이티브 자체 화면으로.

**트랙 5 — SwiftUI UI 재작성 (가장 큼)**
- 스크롤백 렌더, 마크다운+코드 하이라이트, 세션 탭, 설정, 서브에이전트 뷰,
  todo/goal 위젯, git 패널. 작업량 대부분.

### 리스크
- questionnaire/btw/custom UI가 RPC에서 어떻게 표현되는지 — 트랙 4 PoC가 게이트.
- 멀티탭 = pi 프로세스 N개 (메모리/관리 비용).
- pi-skills의 web 우회(`PI_WEB_HOST`)를 네이티브용으로 일반화할지(스코프 결정 필요).

---

## 5. 다음 세션에서 바로 할 일 (순서)

1. **RPC PoC 마저**: `pi --mode rpc`에 실제 `prompt` 보내서 message_update 스트리밍,
   tool_execution_*, agent_end 왕복 확인. (작업 디렉토리 지정해서 실제 세션 파일 쓰기도 확인)
2. **확장 UI PoC**: confirm/select 유발하는 상황 만들어 `extension_ui_request`/`response`
   왕복 확인. questionnaire/btw가 RPC에서 어떻게 나오는지 관찰.
3. **lock PoC**: 같은 세션을 RPC로 열고, TUI나 다른 RPC로 takeover 시 동작 확인.
   `shared/session-lock.ts` 읽고 Swift 포팅 스펙 뽑기.
4. PoC 통과하면 **계획서를 트랙별 세부 작업 목록으로 확장**하고 **새 브랜치 생성**해서 트랙 1(Browsing) 착수.

### 하지 말 것
- pi 업데이트 금지.
- `/Applications/pi.app` 부팅 금지.
- RPC PoC는 `--no-session` 또는 임시 `--session-dir`로. 실제 사용자 세션 파일에 쓰지 말 것.
- 거대 세션(225M harness-research, 176M tokyo-harness)을 통째로 메모리에 올리는 짓 금지.

---

## 참고 파일/경로
- RPC 문서: `~/.nvm/.../node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- 세션 포맷: 같은 docs의 `session-format.md`
- 현 백엔드 SDK 사용처: `server/index.ts:33`, `server/runtime-manager.ts:16-23`
- lock 프로토콜(byte-identical 대상): `vendor/pi-skills/extensions/session-lock/shared/session-lock.ts`
- 현 UI 브릿지: `server/web-ui-context.ts`, `web/use-session.ts`(entriesToMessages = 선형 렌더 증거)
- AGENTS.md 하드룰: lock 가드, owner="pi-web" 유지, byte-identical lock 프로토콜.

---

## §A. PoC 결과 (검증 완료 — 2026-06-10 세션 2)

세 PoC 모두 실제 실행해 통과. PoC 스크립트는 `/tmp/pi-rpc-poc/`(poc.mjs, poc2.mjs,
poc3-lock.mjs)에 남겨둠 — 재현 필요 시 참고. 모델은 `relay/claude-opus-4.8`, 임시
`--session-dir`로 실행(사용자 세션 미접촉). 끝난 뒤 lock orphan 없음 확인.

### PoC 1 — prompt 왕복 (OK)
- `get_state` → model 객체(contextWindow 200000, cost 등) + `sessionFile`/`sessionId` 반환.
- `prompt` → `agent_start` → `turn_start` → message_start/end **2회**(thinking 블록 + text
  블록) → `turn_end` → `agent_end`(messages=2). 스트리밍 델타는 message_update의
  `assistantMessageEvent`(text_start/text_delta×N/text_end)로 온다.
- `get_session_stats` → tokens/cost/contextUsage 정상.
- 세션 jsonl 줄 구성: `session` → `model_change` → `thinking_level_change` → `message`(user)
  → `message`(assistant). 각 줄 `id`/`parentId`/`timestamp` 체인(parentId로 트리 구성).
  assistant 메시지 `usage`는 jsonl에서 `totalTokens`(키 `total` 아님), RPC stats는
  `total` — **필드명 다름 주의**.
- **함의: tool_execution_*까지는 PoC1에서 안 도는 게섬**(단순 응답이라 툴콜 없음).
  도큐 이벤트 스키마는 docs에 명확하니 트랙 3 구현 시 실제 툴 유발해 한 번 더 확인할 것.

### PoC 2 — 확장 UI 다이얼로그 왕복 (OK)
- `--no-extensions -e rpc-demo.ts`로 rpc-demo만 로드 → `/rpc-input`, `/rpc-editor`
  프롬프트로 다이얼로그 유발.
- `input` 다이얼로그: `extension_ui_request{method:input, id, title, placeholder}` → 클라가
  `extension_ui_response{id, value}` 회신 → 성공. `editor`도 동일(`prefill` 필드, value 회신).
- fire-and-forget(setTitle/setWidget/setStatus/notify)는 응답 불필. **`setStatus`의
  `statusText`에 ANSI 이스케이프(`\u001b[38;2;...m`)가 그대로 실림** → 네이티브
  렌더러는 ANSI strip/파싱 필요(PoC3에서 `/\u001b\[[0-9;]*m/g` 제거로 확인).
- **트랙 4 게이트 해소**: `question`/`btw` 둘 다 `index.ts`에 `process.env.PI_WEB_HOST`
  분기가 있으며, 그 분기는 `ctx.ui.custom`(터미널 전용) 대신 **표준 `ctx.ui.select`/
  `input`/`notify`로 폴백**한다(question/index.ts:181, btw/index.ts:149). 이 표준
  다이얼로그는 RPC에서 증명됨. 그래서 **네이티브는 spawn 시 `PI_WEB_HOST=1`만
  세팅하면 된다 — pi-skills 변경 불필, 스코프 깔끔하게 유지.** (questionnaire 전용
  `ctx.ui.questionnaire` 어댑터는 선택사항 — 없으면 question이 select/input 연쇄로
  자동 폴백하므로 MVP는 그걸로 충분.)
- `ctx.ui.custom`은 RPC에서 undefined(docs 확인) → subagents 런 뷰어 등은 네이티브
  자체 화면으로.

### PoC 3 — lock 인터운 (OK, 아키텍처 확정)
실제 `shared/session-lock.ts`(byte-identical 소스)를 host 쪽으로 구동해 검증:
- **A**: 평범한 `pi --mode rpc`는 자기 세션을 `owner="pi"`, label `"TUI"`로 자가 락
  (`🔓 owned`), 종료 시 깨끗히 release(orphan 없음).
- **B/C**: host가 같은 파일을 `owner="pi-web"`로 잡은 뒤 평범한 pi가 그 세션을
  resume하면 → `🔒 read-only (locked elsewhere)` + takeover confirm 낚싯. 거절하면
  host가 계속 소유. → **cross-owner(pi ↔ pi-web) 프로토콜 호환 실측 확인.**
- **D**: `PI_WEB_HOST=1`로 resume하면 session-lock 확장이 **완전 bail**(lock 이벤트 0개,
  confirm 0개), host가 lock 유지. (index.ts:26-29 그대로.)

**→ 확정된 lock 아키텍처:** Swift가 `owner="pi-web"`로 lock을 소유하고,
`pi --mode rpc`는 `PI_WEB_HOST=1`로 spawn한다. AGENTS.md의 로드베어링
`lock.isMine()` re-check(매 prompt 전)는 **Swift로 옮겨온다** — PI_WEB_HOST가 서면
pi쪽은 강제를 안 하므로 host가 유일한 출적 가드다. 다른 RPC/TUI가 takeover하면
disk token이 바뀌어 Swift의 isMine()이 false로 떨어지므로, prompt 전 검사에서
차단하고 read-only로 다운그레이드해야 한다.

### 세 PoC에서 나온 Swift 구현 주의사항 (종합)
1. **프레이밍**: LF만 레코드 구분. `\r\n` 입력은 trailing `\r` strip. U+2028/2029는
   newline 취급 금지(JSON 문자열 안에 들어감). Swift에서 직접 버퍼 분할.
2. **stdout에 이벤트·응답·extension_ui_request 세 종류가 섞임**. `type`으로 분기:
   `response`(id correlation), `extension_ui_request`(dialog면 응답 필요), 나머지 event.
3. **한 턴에 message 여러 개**(thinking + text + toolCall 블록). content 배열 순회 렌더.
4. **ANSI 이스케이프** statusText/widgetLines에 섞임 → strip 필수.
5. **PI_WEB_HOST=1 필수** (lock self-deadlock 회피 + question/btw 네이티브 폴백 활성화).
6. 세션 영구저장은 `--session-dir`로 지정(기본 `~/.pi/agent/sessions/--<cwd>--/`)
   아니면 pi 기본 경로 사용. cwd는 spawn 시 프로세스 cwd로 주입.
7. **앱 번들 식별자: `me.mingeon.pi.swift`** (기존 Tauri 앱 `me.mingeon.pi-gui`와 분리 —
   localStorage/WebKit 데이터 충돌 없음).
