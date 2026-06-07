// Maps session ID (file path) -> a live AgentSession runtime.
//
// Cost model (proven in the PoC):
//   - listing / reading past sessions = no runtime needed (file I/O)
//   - a runtime spins up only the moment a prompt is sent
//
// Lock model (the SessionLock protocol shared with the extension):
//   - to go live you must grab the exclusive lock on that session file.
//   - if another side (TUI / another pi-web) already holds it, refuse. No auto-takeover.
//   - if the caller passes force=true explicitly, take it over.
//   - "right before every prompt send", re-verify the lock is still mine.
//     if someone took it (revoked), tear down that runtime immediately and refuse.

import { existsSync } from 'node:fs';
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

// Same minimal set as pi-ai's ImageContent (pi-ai is not a direct dependency, so declared locally).
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

import { type LockRecord, SessionLock } from '../shared/session-lock.ts';
import { WebUIContext } from './web-ui-context.ts';

export type Subscriber = (event: unknown) => void;

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelView {
  provider: string;
  id: string;
  name: string;
}

// Session controls/stats snapshot (for the info panel). Filled only when a runtime exists.
export interface SessionControls {
  live: boolean;
  model: ModelView | null;
  thinkingLevel: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  name: string | null;
  stats: unknown; // SessionStats (includes tokens/cost/contextUsage)
  queue?: { steering: string[]; followUp: string[] }; // queued messages while streaming
}

export interface LiveRuntime {
  key: string; // session file path
  session: AgentSession;
  cwd: string;
  lock: SessionLock;
  lastActivity: number;
  unsubscribe: () => void;
  ui: WebUIContext; // interactive UI bridge (select/confirm/input/notify)
  subagentPoll?: ReturnType<typeof setInterval>; // watches subagent-run entries for changes (no events)
  subagentSig?: string; // previous signature (broadcast only on change)
}

export class LockedError extends Error {
  current?: LockRecord;
  constructor(current?: LockRecord) {
    super('session is locked by another owner');
    this.name = 'LockedError';
    this.current = current;
  }
}

export class RevokedError extends Error {
  by?: LockRecord;
  constructor(by?: LockRecord) {
    super('session lock was lost (taken over or removed)');
    this.name = 'RevokedError';
    this.by = by;
  }
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class RuntimeManager {
  private runtimes = new Map<string, LiveRuntime>();
  // Subscription channels: a subscriber Set per session path. It exists independently
  // of any runtime - an SSE client can attach without a runtime (view/receive), and when
  // a runtime spins up, its events are broadcast onto this channel.
  private channels = new Map<string, Set<Subscriber>>();
  private auth = AuthStorage.create();
  private registry = ModelRegistry.create(this.auth);
  // Settings manager used to read the default efficiency (thinking) value (for the non-live input default).
  private settings = SettingsManager.create(process.cwd());
  private reaper: ReturnType<typeof setInterval>;

  constructor() {
    this.reaper = setInterval(() => this.reapIdle(), 60 * 1000);
    this.reaper.unref?.();
  }

  /**
   * Subscribe to an event channel. Needs neither a lock nor a runtime (receive only).
   * Call the returned function to unsubscribe.
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

  /** Broadcast an event to every subscriber of one session channel. */
  private broadcast(sessionPath: string, event: unknown) {
    const set = this.channels.get(sessionPath);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* subscriber isolation */
      }
    }
  }

  /** Broadcast to subscribers of all session channels (for global notifications). */
  broadcastAll(event: unknown) {
    for (const set of this.channels.values()) {
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          /* subscriber isolation */
        }
      }
    }
  }

  /**
   * Spin a session up live. Succeeds only if the lock is grabbed.
   * @param force if true, forcibly take over from the existing holder.
   * @param cwd  working directory to use when launching a pending session (no file yet).
   * @throws LockedError when the lock is held by someone else and force is not set.
   */
  async getOrCreate(
    sessionPath: string,
    opts: {
      force?: boolean;
      cwd?: string;
      model?: { provider: string; id: string };
      thinkingLevel?: string;
    } = {},
  ): Promise<LiveRuntime> {
    const existing = this.runtimes.get(sessionPath);
    if (existing) {
      // Even a runtime I already spun up may have been taken from me in the meantime.
      if (existing.lock.isLost()) {
        await this.dispose(sessionPath, { keepLock: true });
        throw new RevokedError(this.recordOf(existing.lock));
      }
      existing.lastActivity = Date.now();
      return existing;
    }

    // Open the session file and try to lock it. For a pending session (no file), create it under cwd.
    const sessionManager =
      !existsSync(sessionPath) && opts.cwd
        ? SessionManager.create(opts.cwd, undefined, { id: undefined })
        : SessionManager.open(sessionPath);
    // The path minted by create may differ from the requested sessionPath, so pin it.
    if (!existsSync(sessionPath) && opts.cwd) {
      sessionManager.setSessionFile?.(sessionPath);
    }
    const cwd = sessionManager.getCwd() || opts.cwd || process.cwd();
    const name = sessionManager.getSessionName?.();
    const lock = new SessionLock(sessionPath, 'pi-web', name ? `pi-web: ${name}` : 'pi-web');

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
      // Apply the model/efficiency chosen before the first message at runtime creation (draft -> actual).
      ...(opts.model
        ? { model: this.registry.find(opts.model.provider, opts.model.id) ?? undefined }
        : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel as never } : {}),
    });

    const unsubscribe = session.subscribe((event) => {
      const rt = this.runtimes.get(sessionPath);
      if (rt) rt.lastActivity = Date.now();
      this.broadcast(sessionPath, event);
    });

    // Interactive UI bridge: relays the extension's ctx.ui.confirm/select/input/notify
    // to the browser over SSE (broadcast on the same channel).
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
    // subagent-run entries are written via appendEntry and do not emit session events
    // (an SDK gap). So the GUI can't see subagent completion until a reload.
    // Lightly poll our own session file from the owned runtime and broadcast only on change.
    runtime.subagentPoll = setInterval(() => this.pollSubagents(sessionPath), 1500);
    runtime.subagentPoll.unref?.();
    return runtime;
  }

  // Read the live runtime's subagent-run entries (latest per runId) and, if changed from before,
  // broadcast { type: "subagent_runs", runs }. The frontend merges by runId.
  private pollSubagents(sessionPath: string) {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return;
    let entries: unknown[];
    try {
      entries = rt.session.sessionManager.getEntries() as unknown[];
    } catch {
      return;
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const e of entries) {
      const ent = e as { type?: string; customType?: string; data?: { runId?: string } };
      if (ent.type === 'custom' && ent.customType === 'subagent-run' && ent.data?.runId) {
        byId.set(ent.data.runId, ent.data as Record<string, unknown>);
      }
    }
    if (byId.size === 0) return;
    const runs = [...byId.values()];
    // Signature: gather only runId+status+turns count+usage.cost to compare (full serialization is costly).
    const sig = runs
      .map(
        (r) =>
          `${r.runId}:${r.status}:${(r.turns as unknown[] | undefined)?.length ?? 0}:${(r.usage as { cost?: number } | undefined)?.cost ?? 0}`,
      )
      .join('|');
    if (sig === rt.subagentSig) return;
    rt.subagentSig = sig;
    this.broadcast(sessionPath, { type: 'subagent_runs', runs });
  }

  /**
   * Send a prompt. The core enforcement point:
   * verify "the lock is mine right before sending every message".
   * @throws RevokedError if the lock was taken away (the runtime is also torn down).
   */
  async prompt(
    sessionPath: string,
    message: string,
    images?: ImageContent[],
    deliverAs?: 'steer' | 'followUp',
  ): Promise<void> {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) throw new Error('no live runtime; call getOrCreate first');

    // -- Lock check right before writing --
    if (!rt.lock.isMine()) {
      const by = this.recordOf(rt.lock);
      await this.dispose(sessionPath, { keepLock: true }); // not my lock, so don't touch someone else's
      throw new RevokedError(by);
    }

    rt.lastActivity = Date.now();
    const hasImages = !!images && images.length > 0;
    if (rt.session.isStreaming) {
      // While streaming: steer (default, immediate intervention) or followUp (delivered after the turn ends).
      if (deliverAs === 'followUp') {
        await rt.session.followUp(message, hasImages ? images : undefined);
      } else {
        await rt.session.steer(message, hasImages ? images : undefined);
      }
    } else {
      rt.session.prompt(message, hasImages ? { images } : undefined).catch((e) => {
        // An error during the prompt also goes out on the event stream, but log it too.
        console.error(`[prompt error ${sessionPath}]`, e);
        // Notify the GUI: so it can show a warning banner on that session tab.
        this.broadcast(sessionPath, {
          type: 'session_error',
          scope: 'prompt',
          message: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }

  /**
   * Abort an in-progress response. Only when the lock is mine (a write-type operation).
   * No-op if there's no runtime or it isn't streaming.
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
   * Ensure the runtime is mine. If absent, spin it up (acquire lock); if present, re-verify the lock.
   * Call this before any write-type operation (changing model/thinking level/name).
   * @throws LockedError held by someone else + not force
   * @throws RevokedError it's my runtime but the lock was taken away
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
    return { provider: m.provider ?? '', id: m.id ?? '', name: m.name ?? m.id ?? '' };
  }

  // Decide the "input default model" for a non-live session:
  //  1) the provider+model of the last assistant response in the session file (it opens with that model to continue)
  //  2) if none (new session), the first available model in the registry (default)
  private resolveModelForView(
    sessionPath: string,
  ): { provider: string; id: string; name: string } | null {
    // 1) Last assistant model from the file.
    try {
      if (existsSync(sessionPath)) {
        const sm = SessionManager.open(sessionPath);
        const entries = sm.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i] as {
            type: string;
            message?: { role?: string; provider?: string; model?: string };
          };
          if (e.type === 'message' && e.message?.role === 'assistant' && e.message.model) {
            const found = this.registry.find(e.message.provider ?? '', e.message.model);
            if (found) return { provider: found.provider, id: found.id, name: found.name };
            return {
              provider: e.message.provider ?? '',
              id: e.message.model,
              name: e.message.model,
            };
          }
        }
      }
    } catch {
      /* file read failure falls back to default */
    }
    // 2) Default: the configured default model -> if none, the first available model.
    try {
      const dp = this.settings.getDefaultProvider?.();
      const dm = this.settings.getDefaultModel?.();
      if (dm) {
        const found = this.registry.find(dp ?? '', dm);
        if (found) return { provider: found.provider, id: found.id, name: found.name };
        return { provider: dp ?? '', id: dm, name: dm };
      }
    } catch {
      /* settings read failure -> fall back to first available model */
    }
    try {
      const first = this.registry.getAvailable()[0];
      if (first) return { provider: first.provider, id: first.id, name: first.name };
    } catch {
      /* no model list */
    }
    return null;
  }

  /** Session controls/stats snapshot. Only live:false if there's no runtime. */
  controls(sessionPath: string): SessionControls {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) {
      // If not live: return the model of the last assistant response in the session file
      // (or the default model if none) as the input default (reads the file only, no runtime).
      const model = this.resolveModelForView(sessionPath);
      // Default efficiency: the configured value or medium. Returned as the input default.
      let defThinking: ThinkingLevel = 'medium';
      try {
        defThinking = (this.settings.getDefaultThinkingLevel?.() as ThinkingLevel) ?? 'medium';
      } catch {
        /* settings read failure -> medium */
      }
      return {
        live: false,
        model,
        thinkingLevel: defThinking,
        availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        supportsThinking: true,
        name: null,
        stats: null,
      };
    }
    let stats: unknown = null;
    try {
      stats = rt.session.getSessionStats();
    } catch {
      /* ignore stats computation failure */
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

  /** Replace the entire queue (for editing/deleting individual items). The SDK only supports clearQueue then re-add.
  // Preserve order: steering first, then followUp. Only when the lock is mine.
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
   * The list of slash commands available for this session. Requires a live runtime.
   *   - extension-registered commands (getRegisteredCommands)  -> /name
   *   - skill commands (resourceLoader.getSkills)              -> /skill:name
   * Execution: send "/..." through the existing prompt flow and the SDK intercepts it
   * (skill via _expandSkillCommand, extension via the command handler).
   */
  commands(sessionPath: string): { name: string; description?: string; source: string }[] {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return [];
    const out: { name: string; description?: string; source: string }[] = [];
    // extension commands
    try {
      const cmds = rt.session.extensionRunner?.getRegisteredCommands?.() ?? [];
      for (const c of cmds as { name: string; invocationName?: string; description?: string }[]) {
        out.push({
          name: c.invocationName || c.name,
          description: c.description,
          source: 'extension',
        });
      }
    } catch {
      /* no extension commands */
    }
    // skill commands (/skill:name)
    try {
      const skills = rt.session.resourceLoader?.getSkills?.()?.skills ?? [];
      for (const s of skills as { name: string; description?: string }[]) {
        out.push({ name: `skill:${s.name}`, description: s.description, source: 'skill' });
      }
    } catch {
      /* no skills */
    }
    return out;
  }

  /** Change model (runtime + lock required). */
  async setModel(
    sessionPath: string,
    provider: string,
    id: string,
    force?: boolean,
  ): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    const model = this.registry.find(provider, id);
    if (!model) throw new Error(`unknown model: ${provider}/${id}`);
    await rt.session.setModel(model);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /** Change thinking level (efficiency) (runtime + lock required). */
  async setThinkingLevel(
    sessionPath: string,
    level: ThinkingLevel,
    force?: boolean,
  ): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    rt.session.setThinkingLevel(level as never);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /** Change session name (runtime + lock required - writes the session file). */
  async rename(sessionPath: string, name: string, force?: boolean): Promise<SessionControls> {
    const rt = await this.ensureMine(sessionPath, force);
    rt.session.setSessionName(name);
    rt.lastActivity = Date.now();
    return this.controls(sessionPath);
  }

  /**
   * Reload extensions/skills (runtime + lock required).
   *   - refuse if a turn is in progress (streaming): reload swaps the extensionRunner,
   *     so the tool-call path must not be shaken while streaming.
   *   - session.reload() swaps in a new runner without recreating the session
   *     (keeps lock/scrollback). Afterward getRegisteredCommands/getSkills are refreshed.
   */
  async reload(sessionPath: string, force?: boolean): Promise<{ ok: boolean; reason?: string }> {
    const rt = await this.ensureMine(sessionPath, force);
    if (rt.session.isStreaming) {
      return { ok: false, reason: 'streaming' };
    }
    await rt.session.reload();
    rt.lastActivity = Date.now();
    return { ok: true };
  }

  /** The list of currently live runtimes. */
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

  /** Forward the browser's UI response to that session's pending Promise. */
  respondUi(sessionPath: string, id: string, value: unknown): boolean {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return false;
    return rt.ui.respond(id, value);
  }

  /** Tear down the runtime. With keepLock=true, don't touch the lock file (when it's already someone else's). */
  async dispose(sessionPath: string, opts: { keepLock?: boolean } = {}): Promise<void> {
    const rt = this.runtimes.get(sessionPath);
    if (!rt) return;
    if (rt.subagentPoll) clearInterval(rt.subagentPoll); // clean up the subagent poller
    rt.ui.cancelAll(); // clear pending UI requests as cancelled
    rt.unsubscribe();
    try {
      await rt.session.abort();
    } catch {
      /* already idle */
    }
    rt.session.dispose?.();
    if (!opts.keepLock) rt.lock.release();
    this.runtimes.delete(sessionPath);
  }

  private recordOf(lock: SessionLock): LockRecord | undefined {
    const st = lock.state();
    return 'record' in st ? st.record : undefined;
  }

  private async reapIdle() {
    const now = Date.now();
    for (const [path, rt] of this.runtimes) {
      if (rt.session.isStreaming) continue;
      // immediately clean up a revoked runtime
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
