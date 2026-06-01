// 세션 ID(파일 경로) → 살아있는 AgentSession 런타임 매핑.
//
// 비용 모델 (PoC 에서 실증):
//   - 목록 보기 / 과거 세션 읽기 = 런타임 불필요 (파일 I/O)
//   - 프롬프트를 보내는 순간에만 런타임이 뜬다
//
// 락 모델 (extension 과 공유하는 SessionLock 규약):
//   - 라이브로 띄우려면 그 세션 파일의 배타 락을 잡아야 한다.
//   - 이미 다른 쪽(TUI/다른 pi-web)이 점유 중이면 거부한다. 자동 탈취 없음.
//   - 호출자가 force=true 로 명시하면 강제 탈취(takeover)한다.
//   - "매번 프롬프트 보내기 직전" 에 락이 여전히 내 것인지 확인한다.
//     누가 뺏어갔으면(revoked) 그 런타임을 즉시 내리고 거부한다.

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

// pi-ai 의 ImageContent 와 동일한 최소 셋 (pi-ai 는 직접 의존이 아니라 로컬로 선언).
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
import { SessionLock, type LockRecord } from "../shared/session-lock.ts";
import { WebUIContext } from "./web-ui-context.ts";

export type Subscriber = (event: unknown) => void;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelView {
  provider: string;
  id: string;
  name: string;
}

// 세션 컨트롤/통계 스냅샷 (info 패널용). 런타임이 있어야 채워진다.
export interface SessionControls {
  live: boolean;
  model: ModelView | null;
  thinkingLevel: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  name: string | null;
  stats: unknown; // SessionStats (tokens/cost/contextUsage 포함)
  queue?: { steering: string[]; followUp: string[] }; // 스트리밍 중 대기열 메시지
}

export interface LiveRuntime {
  key: string; // 세션 파일 경로
  session: AgentSession;
  cwd: string;
  lock: SessionLock;
  lastActivity: number;
  unsubscribe: () => void;
  ui: WebUIContext; // 인터랙티브 UI 브릿지 (select/confirm/input/notify)
}

export class LockedError extends Error {
  current?: LockRecord;
  constructor(current?: LockRecord) {
    super("session is locked by another owner");
    this.name = "LockedError";
    this.current = current;
  }
}

export class RevokedError extends Error {
  by?: LockRecord;
  constructor(by?: LockRecord) {
    super("session lock was lost (taken over or removed)");
    this.name = "RevokedError";
    this.by = by;
  }
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class RuntimeManager {
  private runtimes = new Map<string, LiveRuntime>();
  // 구독 채널: 세션 경로별 subscriber Set. 런타임 존재와 무관하게
  // 존재한다 — 런타임 없이도 SSE 가 붙을 수 있고(보기/수신), 런타임이
  // 뜨면 그 이벤트가 이 채널로 브로드캐스트된다.
  private channels = new Map<string, Set<Subscriber>>();
  private auth = AuthStorage.create();
  private registry = ModelRegistry.create(this.auth);
  // 기본 효율(thinking) 값을 읽기 위한 설정 매니저 (non-live input default 용).
  private settings = SettingsManager.create(process.cwd());
  private reaper: ReturnType<typeof setInterval>;

  constructor() {
    this.reaper = setInterval(() => this.reapIdle(), 60 * 1000);
    this.reaper.unref?.();
  }

  /**
   * 이벤트 채널에 구독한다. 락도 런타임도 필요 없다 (수신 전용).
   * 반환하는 함수를 호출하면 구독이 해제된다.
   */
  subscribe(sessionPath: string, fn: Subscriber): () => void {
    let set = this.channels.get(sessionPath);
    if (!set) {
      set = new Set();
      this.channels.set(sessionPath, set);
    }
    set.add(fn);
    return () => {
      const s = this.channels.get(sessionPath);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.channels.delete(sessionPath);
    };
  }

  /** 한 세션 채널의 모든 구독자에게 이벤트를 뿌린다. */
  private broadcast(sessionPath: string, event: unknown) {
    const set = this.channels.get(sessionPath);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* 구독자 격리 */
      }
    }
  }

  /** 모든 세션 채널의 구독자에게 뾌린다 (전역 알림용). */
  broadcastAll(event: unknown) {
    for (const set of this.channels.values()) {
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          /* 구독자 격리 */
        }
      }
    }
  }

  /**
   * 세션을 라이브로 띄운다. 락을 잡아야 성공한다.
   * @param force true 면 기존 점유자로부터 강제 탈취.
   * @param cwd  pending 세션(파일 아직 없음)을 띄울 때 쓸 작업 디렉터리.
   * @throws LockedError 락이 남에게 있고 force 가 아닐 때.
   */
  async getOrCreate(
    sessionPath: string,
    opts: { force?: boolean; cwd?: string; model?: { provider: string; id: string }; thinkingLevel?: string } = {},
  ): Promise<LiveRuntime> {
    const existing = this.runtimes.get(sessionPath);
    if (existing) {
      // 내가 이미 띄운 런타임이라도, 그 사이 뺏겼을 수 있다.
      if (existing.lock.isLost()) {
        await this.dispose(sessionPath, { keepLock: true });
        throw new RevokedError(this.recordOf(existing.lock));
      }
      existing.lastActivity = Date.now();
      return existing;
    }

    // 세션 파일을 열고 락을 시도한다. pending 세션이면(파일 없음) cwd 로 새로 만든다.
    const sessionManager =
      !existsSync(sessionPath) && opts.cwd
        ? SessionManager.create(opts.cwd, undefined, { id: undefined })
        : SessionManager.open(sessionPath);
    // create 가 발급한 경로가 요청된 sessionPath 와 다를 수 있으므로 고정시킨다.
    if (!existsSync(sessionPath) && opts.cwd) {
      sessionManager.setSessionFile?.(sessionPath);
    }
    const cwd = sessionManager.getCwd() || opts.cwd || process.cwd();
    const name = sessionManager.getSessionName?.();
    const lock = new SessionLock(sessionPath, "pi-web", name ? `pi-web: ${name}` : "pi-web");

    if (opts.force) {
      lock.takeover();
    } else {
      const { acquired, current } = lock.tryAcquire();
      if (!acquired) throw new LockedError(current);
    }

    const { session } = await createAgentSession({
      cwd,
      authStorage: this.auth,
      modelRegistry: this.registry,
      sessionManager,
      // 첫 메시지 전에 고른 모델/효율을 런타임 생성 시 적용 (draft → 실제).
      ...(opts.model ? { model: this.registry.find(opts.model.provider, opts.model.id) ?? undefined } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel as never } : {}),
    });

    const unsubscribe = session.subscribe((event) => {
      const rt = this.runtimes.get(sessionPath);
      if (rt) rt.lastActivity = Date.now();
      this.broadcast(sessionPath, event);
    });

    // 인터랙티브 UI 브릿지: extension 의 ctx.ui.confirm/select/input/notify 를
    // SSE 로 브라우저에 전달한다 (같은 채널로 broadcast).
    const ui = new WebUIContext((event) => this.broadcast(sessionPath, event));
    await session.bindExtensions({ uiContext: ui as never });

    const runtime: LiveRuntime = {
      key: sessionPath,
      session,
      cwd,
      lock,
      lastActivity: Date.now(),
      unsubscribe,
      ui,
    };
    this.runtimes.set(sessionPath, runtime);
    return runtime;
  }

  /**
   * 프롬프트를 보낸다. 핵심 강제 지점:
   * "매번 메시지 보내기 직전에 락이 나한테 있는지" 확인한다.
   * @throws RevokedError 락을 뺏긴 경우 (런타임도 내려간다).
   */
  async prompt(
    sessionPath: string,
    message: string,
    images?: ImageContent[],
    deliverAs?: "steer" | "followUp",
  ): Promise<void> {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) throw new Error("no live runtime; call getOrCreate first");

    // ── 쓰기 직전 락 확인 ──
    if (!rt.lock.isMine()) {
      const by = this.recordOf(rt.lock);
      await this.dispose(sessionPath, { keepLock: true }); // 내 락 아니므로 남의 락 건드리지 않음
      throw new RevokedError(by);
    }

    rt.lastActivity = Date.now();
    const hasImages = !!images && images.length > 0;
    if (rt.session.isStreaming) {
      // 스트리밍 중: steer(기본, 즉시 개입) 또는 followUp(틴 끝난 뒤 전달).
      if (deliverAs === "followUp") {
        await rt.session.followUp(message, hasImages ? images : undefined);
      } else {
        await rt.session.steer(message, hasImages ? images : undefined);
      }
    } else {
      rt.session.prompt(message, hasImages ? { images } : undefined).catch((e) => {
        // 프롬프트 도중 에러는 이벤트 스트림으로도 나가지만, 로깅도 남긴다.
        console.error(`[prompt error ${sessionPath}]`, e);
        // GUI 에 알린다: 해당 세션 탭에 경고 배너를 띄울 수 있게.
        this.broadcast(sessionPath, {
          type: "session_error",
          scope: "prompt",
          message: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }

  /**
   * 진행 중인 응답을 중단한다. 락이 내 것일 때만 (쓰기성 작업).
   * 런타임이 없거나 스트리밍 중이 아니면 no-op.
   */
  async abort(sessionPath: string): Promise<{ aborted: boolean }> {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return { aborted: false };
    if (!rt.lock.isMine()) return { aborted: false };
    rt.lastActivity = Date.now();
    try {
      await rt.session.abort();
      return { aborted: true };
    } catch {
      return { aborted: false };
    }
  }
  /**
   * 런타임이 내 것이도록 보장한다. 없으면 띄우고(락 획득), 있으면 락 재확인.
   * 쓰기성 작업(모델/사고수준/이름 변경) 전에 호출한다.
   * @throws LockedError 남이 점유 중 + force 아님
   * @throws RevokedError 내 런타임인데 락을 뺏긴 경우
   */
  private async ensureMine(sessionPath: string, force?: boolean): Promise<LiveRuntime> {
    const rt = await this.getOrCreate(sessionPath, { force });
    if (!rt.lock.isMine()) {
      const by = this.recordOf(rt.lock);
      await this.dispose(sessionPath, { keepLock: true });
      throw new RevokedError(by);
    }
    return rt;
  }

  private modelViewOf(rt: LiveRuntime): ModelView | null {
    const m = rt.session.model as { provider?: string; id?: string; name?: string } | undefined;
    if (!m) return null;
    return { provider: m.provider ?? "", id: m.id ?? "", name: m.name ?? m.id ?? "" };
  }

  // 라이브 아닌 세션의 "input default 모델"을 정한다:
  //  1) 세션 파일의 마지막 assistant 응답 provider+model (이어서 쓸 때 그 모델로 열림)
  //  2) 없으면(새 세션) 레지스트리의 첫 가용 모델(기본)
  private resolveModelForView(
    sessionPath: string,
  ): { provider: string; id: string; name: string } | null {
    // 1) 파일에서 마지막 assistant 모델.
    try {
      if (existsSync(sessionPath)) {
        const sm = SessionManager.open(sessionPath);
        const entries = sm.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i] as { type: string; message?: { role?: string; provider?: string; model?: string } };
          if (e.type === "message" && e.message?.role === "assistant" && e.message.model) {
            const found = this.registry.find(e.message.provider ?? "", e.message.model);
            if (found) return { provider: found.provider, id: found.id, name: found.name };
            return {
              provider: e.message.provider ?? "",
              id: e.message.model,
              name: e.message.model,
            };
          }
        }
      }
    } catch {
      /* 파일 읽기 실패는 기본으로 폴백 */
    }
    // 2) 기본: 설정의 default model → 없으면 첫 가용 모델.
    try {
      const dp = this.settings.getDefaultProvider?.();
      const dm = this.settings.getDefaultModel?.();
      if (dm) {
        const found = this.registry.find(dp ?? "", dm);
        if (found) return { provider: found.provider, id: found.id, name: found.name };
        return { provider: dp ?? "", id: dm, name: dm };
      }
    } catch {
      /* 설정 읽기 실패 → 첫 가용 모델로 폴백 */
    }
    try {
      const first = this.registry.getAvailable()[0];
      if (first) return { provider: first.provider, id: first.id, name: first.name };
    } catch {
      /* 모델 목록 없음 */
    }
    return null;
  }

  /** 세션 컨트롤/통계 스냅샷. 런타임 없으면 live:false 만. */
  controls(sessionPath: string): SessionControls {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) {
      // 라이브 아니면: 세션 파일의 마지막 assistant 응답 모델(없으면 기본 모델)을
      // input default 로 내려준다 (런타임 안 띄우고 파일만 읽음).
      const model = this.resolveModelForView(sessionPath);
      // 기본 효율: 설정값 또는 medium. input default 로 내려준다.
      let defThinking: ThinkingLevel = "medium";
      try {
        defThinking = (this.settings.getDefaultThinkingLevel?.() as ThinkingLevel) ?? "medium";
      } catch {
        /* 설정 읽기 실패 → medium */
      }
      return {
        live: false,
        model,
        thinkingLevel: defThinking,
        availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        supportsThinking: true,
        name: null,
        stats: null,
      };
    }
    let stats: unknown = null;
    try {
      stats = rt.session.getSessionStats();
    } catch {
      /* 통계 산출 실패는 무시 */
    }
    return {
      live: true,
      model: this.modelViewOf(rt),
      thinkingLevel: (rt.session.thinkingLevel as ThinkingLevel) ?? null,
      availableThinkingLevels: (rt.session.getAvailableThinkingLevels?.() as ThinkingLevel[]) ?? [],
      supportsThinking: rt.session.supportsThinking?.() ?? false,
      name: rt.session.sessionName ?? null,
      stats,
      queue: {
        steering: [...(rt.session.getSteeringMessages?.() ?? [])],
        followUp: [...(rt.session.getFollowUpMessages?.() ?? [])],
      },
    };
  }

  /** 대기열을 통째로 교체한다(개별 수정/삭제용). SDK 는 clearQueue 후 재추가만 지원.
  // 순서 유지: steering 먼저, 그다음 followUp. 락이 내 것일 때만.
  setQueue(sessionPath: string, steering: string[], followUp: string[]): { ok: boolean } {
    const rt = this.runtimes.get(sessionPath);
    if (!rt || !rt.lock.isMine()) return { ok: false };
    try {
      rt.session.clearQueue();
      for (const m of steering) void rt.session.steer(m);
      for (const m of followUp) void rt.session.followUp(m);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * 이 세션의 사용 가능한 슬래시 커맨드 목록. 라이브 런타임 필요.
   *   - extension 등록 커맨드 (getRegisteredCommands)  → /name
   *   - skill 커맨드 (resourceLoader.getSkills)         → /skill:name
   * 실행은 기존 prompt 플로우로 "/..." 를 보내면 SDK 가 가로채다
   * (skill 은 _expandSkillCommand, extension 은 command 핸들러).
   */
  commands(sessionPath: string): { name: string; description?: string; source: string }[] {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return [];
    const out: { name: string; description?: string; source: string }[] = [];
    // extension 커맨드
    try {
      const cmds = rt.session.extensionRunner?.getRegisteredCommands?.() ?? [];
      for (const c of cmds as { name: string; invocationName?: string; description?: string }[]) {
        out.push({ name: c.invocationName || c.name, description: c.description, source: "extension" });
      }
    } catch {
      /* extension 커맨드 없음 */
    }
    // skill 커맨드 (/skill:name)
    try {
      const skills = rt.session.resourceLoader?.getSkills?.()?.skills ?? [];
      for (const s of skills as { name: string; description?: string }[]) {
        out.push({ name: `skill:${s.name}`, description: s.description, source: "skill" });
      }
    } catch {
      /* skill 없음 */
    }
    return out;
  }

  /** 모델 변경 (런타임+락 필요). */
  async setModel(sessionPath: string, provider: string, id: string, force?: boolean): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    const model = this.registry.find(provider, id);
    if (!model) throw new Error(`unknown model: ${provider}/${id}`);
    await rt.session.setModel(model);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /** 사고 수준(efficiency) 변경 (런타임+락 필요). */
  async setThinkingLevel(sessionPath: string, level: ThinkingLevel, force?: boolean): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    rt.session.setThinkingLevel(level as never);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /** 세션 이름 변경 (런타임+락 필요 — 세션 파일 쓰기). */
  async rename(sessionPath: string, name: string, force?: boolean): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    rt.session.setSessionName(name);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /** 현재 떠 있는 라이브 런타임 목록. */
  listLive() {
    return [...this.runtimes.values()].map((rt) => ({
      key: rt.key,
      cwd: rt.cwd,
      streaming: rt.session.isStreaming,
      lastActivity: rt.lastActivity,
      lockMine: rt.lock.isMine(),
    }));
  }

  get(sessionPath: string): LiveRuntime | undefined {
    return this.runtimes.get(sessionPath);
  }

  /** 브라우저의 UI 응답을 해당 세션의 보류 Promise 로 전달. */
  respondUi(sessionPath: string, id: string, value: unknown): boolean {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return false;
    return rt.ui.respond(id, value);
  }

  /** 런타임을 내린다. keepLock=true 면 락 파일은 건드리지 않는다(이미 남의 것일 때). */
  async dispose(sessionPath: string, opts: { keepLock?: boolean } = {}): Promise<void> {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return;
    rt.ui.cancelAll(); // 보류 중인 UI 요청을 취소로 정리
    rt.unsubscribe();
    try {
      await rt.session.abort();
    } catch {
      /* 이미 idle */
    }
    rt.session.dispose?.();
    if (!opts.keepLock) rt.lock.release();
    this.runtimes.delete(sessionPath);
  }

  private recordOf(lock: SessionLock): LockRecord | undefined {
    const st = lock.state();
    return "record" in st ? st.record : undefined;
  }

  private async reapIdle() {
    const now = Date.now();
    for (const [path, rt] of this.runtimes) {
      if (rt.session.isStreaming) continue;
      // 뺏긴 런타임은 즉시 정리
      if (rt.lock.isLost()) {
        await this.dispose(path, { keepLock: true });
        continue;
      }
      if (now - rt.lastActivity > IDLE_TIMEOUT_MS) {
        await this.dispose(path);
      }
    }
  }

  get available() {
    return this.registry.getAvailable();
  }

  shutdown() {
    clearInterval(this.reaper);
    return Promise.all([...this.runtimes.keys()].map((p) => this.dispose(p)));
  }
}
