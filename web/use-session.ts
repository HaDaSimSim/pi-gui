// Hook that manages the live state of a single session tab.
//
// Behavior:
//   1. On mount, load existing entries (scrollback) — no runtime/lock needed
//   2. SSE subscription — view-only, no lock needed
//   3. On prompt send the backend spins up a runtime+lock. 409 transitions to lock-conflict state
//   4. Accumulate streaming deltas (text/thinking/tool) and compose them into displayed messages

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ApiError,
  api,
  type LockRecord,
  type SessionControls,
  type SessionEntry,
  subscribeEvents,
  type ThinkingLevel,
} from './api';
import { reportStreaming } from './config';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'subagent' | 'bash';

export interface SubagentTranscriptItem {
  kind: 'thinking' | 'text' | 'toolCall' | 'toolResult';
  text: string;
  toolName?: string;
  // Rich GUI-only fields the subagents extension now persists (optional; older
  // sessions won't have them, so readers must tolerate undefined).
  args?: Record<string, unknown>; // full tool-call arguments (toolCall)
  isError?: boolean; // result error flag (toolResult)
  fullText?: string; // untruncated result text (toolResult)
}

export interface SubagentRunView {
  runId: string;
  agent: string;
  title: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  model?: string;
  turns: {
    prompt: string;
    finalOutput: string;
    error?: string;
    transcript?: SubagentTranscriptItem[];
  }[];
  cost?: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'done' | 'error';
  resultText?: string;
}

export interface BashRunView {
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean; // `!!` prefix: kept out of LLM context
  running?: boolean; // streaming output, no terminal result yet
}

export interface ChatMessage {
  key: string;
  role: ChatRole;
  text: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  streaming?: boolean;
  model?: string;
  time?: string; // ISO timestamp (for meta display)
  elapsedMs?: number; // response elapsed time (agent_start → message_end)
  interrupted?: boolean; // whether the turn was aborted by the user
  errorMessage?: string; // error text when the turn ended in abort/error (TUI mirroring)
  subagentRun?: SubagentRunView; // subagent-run entry from the subagents extension
  bash?: BashRunView; // user `!`/`!!` bash execution (TUI user_bash mirroring)
}

export interface LockConflict {
  kind: 'locked' | 'revoked';
  by?: LockRecord;
}

export interface SessionState {
  messages: ChatMessage[];
  streaming: boolean;
  live: boolean;
  conflict: LockConflict | null;
  error: string | null;
  loading: boolean;
  controls: SessionControls | null; // model/effort/context/name snapshot (for info panel)
  name: string | null; // session name (scrollback + rename + live updates)
  uiRequest: UiRequest | null; // extension's ctx.ui.confirm/select/input request (bridge)
  queue: { steering: string[]; followUp: string[] }; // queued messages during streaming
  // Auto-retry (429/timeout/overload etc.) progress state. Mirrors the TUI retry loader.
  retry: { attempt: number; maxAttempts: number; until: number; reason: string } | null;
  // Context compaction progress state. Mirrors the TUI compaction loader.
  compaction: { reason: 'manual' | 'threshold' | 'overflow' } | null;
  // Latest todo list (todo extension, via the GUI-state bridge). null = none.
  todo: TodoStateView | null;
  // Latest goal state (goal extension, via the GUI-state bridge). null = none.
  goal: GoalStateView | null;
}

export interface TodoItemView {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface TodoStateView {
  todos: TodoItemView[];
}
export interface GoalStateView {
  objective: string;
  status: 'pursuing' | 'paused' | 'achieved' | 'blocked' | 'budget-limited';
  iteration: number;
  tokenBudget?: number;
  note?: string;
  createdAt: number;
}

export interface UiQuestionOption {
  value: string;
  label: string;
  description?: string;
}
export interface UiQuestion {
  id: string;
  label: string;
  prompt: string;
  options: UiQuestionOption[];
  multiSelect: boolean;
}
export interface UiAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
  values?: string[];
  labels?: string[];
}

export interface UiRequest {
  id: string;
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'questionnaire' | 'btw';
  title: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  questions?: UiQuestion[];
  answer?: string;
}

// Convert session file entries (scrollback) into displayed messages.
function entriesToMessages(entries: SessionEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // The subagents extension appends one run multiple times (start→per turn→done).
  // The same runId is overwritten with the latest snapshot (keeping its first appearance position) — same as TUI.
  const subagentIdx = new Map<string, number>();
  for (const e of entries) {
    // subagent-run custom entry from the subagents extension (type:"custom").
    // shape guard: pi has no extension identifier, so customType is a global flat namespace.
    // To avoid breaking if a third party uses the same 'subagent-run' type with a different shape,
    // check our producer's signature (data.runId: string) and ignore otherwise.
    if (
      e.type === 'custom' &&
      (e as any).customType === 'subagent-run' &&
      typeof (e as any).data?.runId === 'string'
    ) {
      const r = (e as any).data as
        | {
            runId: string;
            agent: string;
            title: string;
            task: string;
            status: 'running' | 'done' | 'failed';
            model?: string;
            usage?: { cost?: number };
            turns?: {
              prompt: string;
              finalOutput: string;
              error?: string;
              transcript?: {
                kind: string;
                text: string;
                toolName?: string;
                args?: Record<string, unknown>;
                isError?: boolean;
                fullText?: string;
              }[];
            }[];
          }
        | undefined;
      if (r?.runId) {
        const view = {
          runId: r.runId,
          agent: r.agent,
          title: r.title,
          task: r.task,
          status: r.status,
          model: r.model,
          cost: r.usage?.cost,
          turns: (r.turns ?? []).map((tn) => ({
            prompt: tn.prompt,
            finalOutput: tn.finalOutput,
            error: tn.error,
            transcript: (tn.transcript ?? []).map((it) => ({
              kind: it.kind as 'thinking' | 'text' | 'toolCall' | 'toolResult',
              text: it.text,
              toolName: it.toolName,
              args: it.args,
              isError: it.isError,
              fullText: it.fullText,
            })),
          })),
        };
        const existing = subagentIdx.get(r.runId);
        if (existing != null) {
          // Update in place with the latest snapshot of the same run (avoids duplicate cards).
          out[existing] = { ...out[existing], subagentRun: view };
        } else {
          subagentIdx.set(r.runId, out.length);
          out.push({
            key: e.id,
            role: 'subagent',
            text: '',
            time: e.timestamp,
            subagentRun: view,
          });
        }
      }
      continue;
    }
    // turn-meta custom entry from ui-cosmetics: elapsed time (seconds) of the previous assistant turn.
    // Attach it to the previous assistant message as elapsedMs.
    // shape guard: details.elapsed(number) is our producer's signature. Even if a third party uses the same
    // 'turn-meta' type, it is ignored in the branch below when elapsed is absent.
    if (e.type === 'custom_message' && (e as any).customType === 'turn-meta') {
      const details = (e as any).details as { elapsed?: number; model?: string } | undefined;
      if (typeof details?.elapsed === 'number') {
        const lastAssistant = [...out].reverse().find((x) => x.role === 'assistant');
        if (lastAssistant) {
          lastAssistant.elapsedMs = details.elapsed * 1000;
          if (!lastAssistant.model && details.model) lastAssistant.model = details.model;
        }
      }
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const role = m.role;
    if (role === 'bashExecution') {
      // User `!`/`!!` command persisted by the SDK's executeBash (TUI user_bash mirroring).
      const bm = m as unknown as {
        command?: string;
        output?: string;
        exitCode?: number;
        cancelled?: boolean;
        truncated?: boolean;
        excludeFromContext?: boolean;
      };
      out.push({
        key: e.id,
        role: 'bash',
        text: '',
        time: e.timestamp,
        bash: {
          command: bm.command ?? '',
          output: bm.output ?? '',
          exitCode: bm.exitCode,
          cancelled: bm.cancelled,
          truncated: bm.truncated,
          excludeFromContext: bm.excludeFromContext,
        },
      });
    } else if (role === 'user') {
      out.push({ key: e.id, role: 'user', text: contentToText(m.content), time: e.timestamp });
    } else if (role === 'assistant') {
      const text = extractAssistantText(m.content);
      const thinking = extractThinking(m.content);
      const toolCalls = extractToolCalls(m.content);
      out.push({
        key: e.id,
        role: 'assistant',
        text,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        model: typeof m.model === 'string' ? m.model : undefined,
        time: e.timestamp,
      });
    } else if (role === 'toolResult') {
      // Attach the result to the previous assistant's toolCall
      const last = [...out].reverse().find((x) => x.role === 'assistant' && x.toolCalls?.length);
      const callId = (m as any).toolCallId;
      const tc = last?.toolCalls?.find((t) => t.id === callId);
      if (tc) {
        tc.status = (m as any).isError ? 'error' : 'done';
        tc.resultText = contentToText(m.content);
      }
    }
  }
  return out;
}

// Extract the latest (last-wins) snapshot of a customType from session entries.
// Mirrors the server-side gui-state-extension's `latest()` so a freshly opened
// (non-live) session shows its persisted todo/goal immediately, instead of
// staying empty until the next live broadcast.
function latestCustom(entries: SessionEntry[], customType: string): unknown {
  let found: unknown;
  for (const e of entries) {
    if (e.type === 'custom' && (e as any).customType === customType) found = (e as any).data;
  }
  return found;
}

function todoFromEntries(entries: SessionEntry[]): TodoStateView | null {
  const d = latestCustom(entries, 'todo-list') as { todos?: TodoItemView[] } | undefined;
  if (!d || !Array.isArray(d.todos) || d.todos.length === 0) return null;
  return { todos: d.todos };
}

function goalFromEntries(entries: SessionEntry[]): GoalStateView | null {
  const d = latestCustom(entries, 'goal-state') as
    | (GoalStateView & { cleared?: boolean })
    | undefined;
  if (!d || d.cleared || typeof d.objective !== 'string') return null;
  return d;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('');
  }
  return '';
}
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return contentToText(content);
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('');
}
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'thinking')
    .map((b: any) => b.thinking)
    .join('');
}
function extractToolCalls(content: unknown): ToolCallView[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'toolCall')
    .map((b: any) => ({ id: b.id, name: b.name, args: b.arguments, status: 'done' as const }));
}

export type NotifyKind =
  | { kind: 'task-complete'; durationSec: number }
  | { kind: 'goal'; status: 'achieved' | 'blocked' | 'budget-limited'; objective: string }
  | { kind: 'question' };

export function useSession(path: string, cwd?: string, onNotify?: (n: NotifyKind) => void) {
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const [state, setState] = useState<SessionState>({
    messages: [],
    streaming: false,
    live: false,
    conflict: null,
    error: null,
    loading: true,
    controls: null,
    name: null,
    uiRequest: null,
    queue: { steering: [], followUp: [] },
    retry: null,
    compaction: null,
    todo: null,
    goal: null,
  });

  // assistant message being accumulated during streaming (updated by events)
  const streamingRef = useRef<ChatMessage | null>(null);
  // turn start time (agent_start) — used to compute elapsed time at message_end (ui-cosmetics style).
  // Persisted to localStorage so a dev HMR remount / prod refresh mid-turn doesn't lose the elapsed
  // clock (the ref resets to 0 on remount otherwise).
  const TURN_START_KEY = `pi-gui.turn-start.${path}`;
  const turnStartRef = useRef<number>(0);
  if (turnStartRef.current === 0) {
    try {
      const saved = Number(localStorage.getItem(TURN_START_KEY));
      if (saved > 0) turnStartRef.current = saved;
    } catch {
      /* ignore */
    }
  }
  const setTurnStart = useCallback(
    (ts: number) => {
      turnStartRef.current = ts;
      try {
        if (ts > 0) localStorage.setItem(TURN_START_KEY, String(ts));
        else localStorage.removeItem(TURN_START_KEY);
      } catch {
        /* ignore */
      }
    },
    [TURN_START_KEY],
  );
  // user abort flag — set on abort call, consumed at the next agent_end to mark the last message as interrupted.
  const interruptedRef = useRef(false);

  // draft model/effort before the first message (no runtime yet so it can't be changed via API; hold it locally
  // and send it with the first prompt). Once a runtime exists, controls carries the real values.
  const [draftModel, setDraftModel] = useState<{ provider: string; id: string } | null>(null);
  const [draftThinking, setDraftThinking] = useState<ThinkingLevel | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // ref to read the latest state from callbacks (for live detection in setModel/setThinking).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Reflect the streaming message at the end of the messages array
  const flushStreaming = useCallback(() => {
    const sm = streamingRef.current;
    setState((s) => {
      if (!sm) return s;
      const msgs = [...s.messages];
      const idx = msgs.findIndex((m) => m.key === sm.key);
      if (idx >= 0) msgs[idx] = { ...sm };
      else msgs.push({ ...sm });
      return { ...s, messages: msgs };
    });
  }, []);

  // Find a tool call by id and update it. Tools run after message_end (tool_execution_*),
  // so streamingRef may already be null at that point. So use streamingRef while streaming,
  // otherwise find and modify it in the already-committed messages. (If create is given, append a new one when missing.)
  const updateToolCall = useCallback(
    (
      toolCallId: string,
      mutate: (tc: ToolCallView) => void,
      create?: { id: string; name: string; args: unknown },
    ) => {
      const sm = streamingRef.current;
      if (sm) {
        sm.toolCalls = sm.toolCalls || [];
        let tc = sm.toolCalls.find((t) => t.id === toolCallId);
        if (!tc && create) {
          tc = { id: create.id, name: create.name, args: create.args, status: 'running' };
          sm.toolCalls.push(tc);
        }
        if (tc) {
          mutate(tc);
          flushStreaming();
          return;
        }
      }
      // Find and modify it in the committed messages.
      setState((s) => {
        const msgs = [...s.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
          const j = m.toolCalls.findIndex((t) => t.id === toolCallId);
          if (j >= 0) {
            const tcs = [...m.toolCalls];
            const next = { ...tcs[j] };
            mutate(next);
            tcs[j] = next;
            msgs[i] = { ...m, toolCalls: tcs };
            return { ...s, messages: msgs };
          }
        }
        // Not found and create is given, so append to the last assistant.
        if (create) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') {
              const tc: ToolCallView = {
                id: create.id,
                name: create.name,
                args: create.args,
                status: 'running',
              };
              mutate(tc);
              msgs[i] = { ...msgs[i], toolCalls: [...(msgs[i].toolCalls ?? []), tc] };
              return { ...s, messages: msgs };
            }
          }
        }
        return s;
      });
    },
    [flushStreaming],
  );

  // Re-read the control snapshot (only meaningful when live).
  const refreshControls = useCallback(() => {
    api
      .controls(path)
      .then((controls) =>
        patch({
          controls,
          ...(controls.name ? { name: controls.name } : {}),
          ...(controls.queue ? { queue: controls.queue } : {}),
        }),
      )
      .catch(() => undefined);
  }, [path, patch]);

  // Report streaming state to Tauri (busy count for quit confirmation). Decremented on unmount.
  useEffect(() => {
    if (!state.streaming) return;
    reportStreaming(true);
    return () => reportStreaming(false);
  }, [state.streaming]);

  // SSE event handling — accumulate streaming deltas
  const handleEvent = useCallback(
    (ev: any) => {
      switch (ev.type) {
        case '_connected':
          patch({ live: ev.live, streaming: ev.streaming });
          break;
        // User `!`/`!!` bash command lifecycle (TUI user_bash mirroring). The backend
        // streams output over the channel; the persisted bashExecution entry is what
        // scrollback renders on reload, so these only drive the live view.
        case 'user_bash_start':
          setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                key: ev.runId,
                role: 'bash',
                text: '',
                time: new Date(ev.timestamp ?? Date.now()).toISOString(),
                bash: {
                  command: ev.command ?? '',
                  output: '',
                  excludeFromContext: ev.excludeFromContext,
                  running: true,
                },
              },
            ],
          }));
          break;
        case 'user_bash_output':
          setState((s) => {
            const msgs = [...s.messages];
            const i = msgs.findIndex((m) => m.key === ev.runId);
            if (i < 0 || !msgs[i].bash) return s;
            msgs[i] = {
              ...msgs[i],
              bash: { ...msgs[i].bash!, output: msgs[i].bash!.output + (ev.chunk ?? '') },
            };
            return { ...s, messages: msgs };
          });
          break;
        case 'user_bash_end':
          setState((s) => {
            const msgs = [...s.messages];
            const i = msgs.findIndex((m) => m.key === ev.runId);
            if (i < 0) return s;
            msgs[i] = {
              ...msgs[i],
              bash: {
                command: ev.command ?? msgs[i].bash?.command ?? '',
                output: ev.output ?? msgs[i].bash?.output ?? '',
                exitCode: ev.exitCode,
                cancelled: ev.cancelled,
                truncated: ev.truncated,
                excludeFromContext: ev.excludeFromContext,
                running: false,
              },
            };
            return { ...s, messages: msgs };
          });
          break;
        case 'ui_request':
          patch({
            uiRequest: {
              id: ev.id,
              kind: ev.kind,
              title: ev.title,
              message: ev.message,
              placeholder: ev.placeholder,
              options: ev.options,
              questions: ev.questions,
              answer: ev.answer,
            },
          });
          // Desktop notification: a turn is waiting on user input.
          onNotifyRef.current?.({ kind: 'question' });
          break;
        case 'ui_cancel':
          // A remote (Telegram) response arrived first and the host asked to close → close only that dialog.
          setState((s) =>
            s.uiRequest && s.uiRequest.id === ev.id ? { ...s, uiRequest: null } : s,
          );
          break;
        case 'ui_notify':
          toast[ev.level === 'error' ? 'error' : ev.level === 'warning' ? 'warning' : 'info'](
            ev.message,
          );
          break;
        case 'session_error':
          // session-level error (prompt/extension etc.) → error banner + toast.
          patch({ streaming: false, error: ev.message || 'session error' });
          toast.error(ev.message || 'session error');
          streamingRef.current = null;
          break;
        case 'backend_error':
          // backend global error (uncaughtException etc.) → warn via toast.
          toast.error(`Backend error: ${ev.message || 'unknown'}`);
          break;
        case 'todo':
          // GUI-state bridge: latest todo list (or null when cleared).
          patch({ todo: (ev.state ?? null) as SessionState['todo'] });
          break;
        case 'goal':
          // GUI-state bridge: latest goal state (or null when cleared).
          patch({ goal: (ev.state ?? null) as SessionState['goal'] });
          // Desktop notification on terminal goal transitions (mirrors telegram).
          {
            const g = ev.state as SessionState['goal'];
            if (
              g &&
              (g.status === 'achieved' || g.status === 'blocked' || g.status === 'budget-limited')
            ) {
              onNotifyRef.current?.({ kind: 'goal', status: g.status, objective: g.objective });
            }
          }
          break;
        case 'session_info_changed':
          // When the session name changes (auto-naming after first message etc.), reflect it live.
          if (ev.name) patch({ name: ev.name });
          break;
        case 'thinking_level_changed':
          refreshControls();
          break;
        case 'queue_update':
          patch({
            queue: {
              steering: [...(ev.steering ?? [])],
              followUp: [...(ev.followUp ?? [])],
            },
          });
          break;
        case 'subagent_runs': {
          // The backend poller notifies of subagent-run entry changes (appendEntry emits no event).
          // Update messages by runId, and add runs that didn't exist.
          const incoming = (ev.runs ?? []) as any[];
          if (incoming.length === 0) break;
          setState((s) => {
            const msgs = [...s.messages];
            const idxByRun = new Map<string, number>();
            msgs.forEach((m, i) => {
              if (m.subagentRun) idxByRun.set(m.subagentRun.runId, i);
            });
            for (const r of incoming) {
              if (!r?.runId) continue;
              const view: SubagentRunView = {
                runId: r.runId,
                agent: r.agent,
                title: r.title,
                task: r.task,
                status: r.status,
                model: r.model,
                cost: r.usage?.cost,
                turns: (r.turns ?? []).map((tn: any) => ({
                  prompt: tn.prompt,
                  finalOutput: tn.finalOutput,
                  error: tn.error,
                  transcript: (tn.transcript ?? []).map((it: any) => ({
                    kind: it.kind,
                    text: it.text,
                    toolName: it.toolName,
                    args: it.args,
                    isError: it.isError,
                    fullText: it.fullText,
                  })),
                })),
              };
              const at = idxByRun.get(r.runId);
              if (at != null) {
                msgs[at] = { ...msgs[at], subagentRun: view };
              } else {
                msgs.push({
                  key: `subagent-${r.runId}`,
                  role: 'subagent',
                  text: '',
                  time: new Date().toISOString(),
                  subagentRun: view,
                });
              }
            }
            return { ...s, messages: msgs };
          });
          break;
        }
        case 'agent_start':
          // When a retry succeeds and the turn starts, clear the retry state.
          patch({ streaming: true, retry: null });
          setTurnStart(Date.now());
          break;
        case 'auto_retry_start':
          // Retry start for 429/timeout/overload etc. TUI style: warning-colored countdown.
          patch({
            retry: {
              attempt: ev.attempt,
              maxAttempts: ev.maxAttempts,
              until: Date.now() + (ev.delayMs ?? 0),
              reason: ev.errorMessage || '',
            },
          });
          break;
        case 'auto_retry_end': {
          // Show the error only on failure (TUI: "Retry failed after N attempts: ...").
          if (!ev.success) {
            const m = `Retry failed after ${ev.attempt} attempt${ev.attempt > 1 ? 's' : ''}: ${ev.finalError || 'Unknown error'}`;
            patch({ retry: null, streaming: false, error: m });
            toast.error(m);
          } else {
            patch({ retry: null });
          }
          break;
        }
        case 'compaction_start':
          patch({ compaction: { reason: ev.reason ?? 'manual' } });
          break;
        case 'compaction_end':
          patch({ compaction: null });
          if (ev.aborted) {
            if (ev.reason === 'manual') toast.error('Compaction cancelled');
            else toast.info('Auto-compaction cancelled');
          } else if (ev.errorMessage) {
            patch({ error: ev.errorMessage });
            toast.error(ev.errorMessage);
          }
          // On success a new compaction-summary entry accumulates in the session, so refresh controls.
          refreshControls();
          break;
        case 'message_start': {
          const msg = ev.message;
          if (msg?.role === 'assistant') {
            streamingRef.current = {
              key: `stream-${Date.now()}`,
              role: 'assistant',
              text: '',
              streaming: true,
              time: new Date().toISOString(),
            };
            flushStreaming();
          } else if (msg?.role === 'user') {
            // user message delivered via steer/followUp. Add it unless already added optimistically.
            const text =
              typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter((c: any) => c.type === 'text')
                      .map((c: any) => c.text)
                      .join('\n')
                  : '';
            if (text.trim()) {
              const trimmed = text.trim();
              setState((s) => {
                // Avoid duplicates. At the start of a turn the SDK re-emits every user
                // message it's about to process (queued followUps + the new prompt) as its
                // own message_start. Comparing only the LAST user message misses a re-emitted
                // followUp when a newer prompt sits after it, so injected messages (e.g.
                // "[subagent … finished]") pile up above each new prompt. Instead, scan the
                // trailing run of user messages (back to the most recent assistant turn) and
                // skip if the same text is already there.
                for (let i = s.messages.length - 1; i >= 0; i--) {
                  const m = s.messages[i];
                  if (m.role === 'assistant') break; // stop at the previous assistant turn
                  if (m.role === 'user' && m.text === trimmed) return s; // already present
                }
                return {
                  ...s,
                  messages: [
                    ...s.messages,
                    {
                      key: `u-${Date.now()}`,
                      role: 'user',
                      text: trimmed,
                      time: new Date().toISOString(),
                    },
                  ],
                };
              });
            }
          }
          break;
        }
        case 'message_update': {
          const d = ev.assistantMessageEvent;
          if (!streamingRef.current) {
            streamingRef.current = {
              key: `stream-${Date.now()}`,
              role: 'assistant',
              text: '',
              streaming: true,
              time: new Date().toISOString(),
            };
          }
          const sm = streamingRef.current;
          if (d?.type === 'text_delta') sm.text += d.delta;
          else if (d?.type === 'thinking_delta') sm.thinking = (sm.thinking || '') + d.delta;
          else if (d?.type === 'toolcall_end' && d.toolCall) {
            sm.toolCalls = sm.toolCalls || [];
            sm.toolCalls.push({
              id: d.toolCall.id,
              name: d.toolCall.name,
              args: d.toolCall.arguments,
              status: 'running',
            });
          }
          flushStreaming();
          break;
        }
        case 'tool_execution_start': {
          updateToolCall(
            ev.toolCallId,
            (tc) => {
              tc.status = 'running';
            },
            { id: ev.toolCallId, name: ev.toolName, args: ev.args },
          );
          break;
        }
        case 'tool_execution_update': {
          // Live-update partial output of a running tool (bash stdout etc.) (TUI mirroring).
          updateToolCall(ev.toolCallId, (tc) => {
            tc.status = 'running';
            tc.resultText = contentToText((ev as any).partialResult?.content);
          });
          break;
        }
        case 'tool_execution_end': {
          updateToolCall(ev.toolCallId, (tc) => {
            tc.status = ev.isError ? 'error' : 'done';
            tc.resultText = contentToText(ev.result?.content);
          });
          break;
        }
        case 'message_end':
          if (streamingRef.current) {
            streamingRef.current.streaming = false;
            // Note: tools run after message_end (tool_execution_*). Forcing running to error
            // here would wrongly mark a tool whose result hasn't arrived yet as failed. Don't touch it.
            // But if the message ended in abort/error, attach errorMessage (TUI mirroring).
            const stop = (ev.message as any)?.stopReason as string | undefined;
            if (stop === 'aborted' || stop === 'error') {
              streamingRef.current.errorMessage =
                (ev.message as any)?.errorMessage ||
                (stop === 'aborted' ? 'Operation aborted' : 'Error');
            }
            flushStreaming();
            streamingRef.current = null;
          }
          break;
        case 'agent_end':
          // Turn end: attach meta (elapsed time) only to the last assistant message.
          // Tools still running after the turn ended are only then treated as failed (abort etc.).
          if (streamingRef.current) {
            flushStreaming();
          }
          setState((s) => {
            const msgs = [...s.messages];
            const wasInterrupted = interruptedRef.current;
            // Discard empty assistant messages (no text/thinking/tool) created right after abort/end.
            while (
              msgs.length > 0 &&
              msgs[msgs.length - 1].role === 'assistant' &&
              !msgs[msgs.length - 1].text.trim() &&
              !msgs[msgs.length - 1].thinking &&
              !msgs[msgs.length - 1].toolCalls?.length &&
              !msgs[msgs.length - 1].subagentRun
            ) {
              msgs.pop();
            }
            // Mark meta/interruption on the last assistant message that has content.
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') {
                const tcs = msgs[i].toolCalls?.map((t) =>
                  wasInterrupted && t.status === 'running' ? { ...t, status: 'error' as const } : t,
                );
                msgs[i] = {
                  ...msgs[i],
                  elapsedMs:
                    turnStartRef.current > 0
                      ? Date.now() - turnStartRef.current
                      : msgs[i].elapsedMs,
                  ...(tcs ? { toolCalls: tcs } : {}),
                  ...(wasInterrupted ? { interrupted: true } : {}),
                };
                break;
              }
            }
            return { ...s, streaming: false, messages: msgs };
          });
          interruptedRef.current = false;
          streamingRef.current = null;
          refreshControls(); // refresh context/cost after the turn ends
          // Desktop notification: mirror telegram's "task complete" (>=30s, not aborted).
          {
            const elapsedSec =
              turnStartRef.current > 0 ? (Date.now() - turnStartRef.current) / 1000 : 0;
            if (elapsedSec >= 30) {
              onNotifyRef.current?.({ kind: 'task-complete', durationSec: Math.round(elapsedSec) });
            }
          }
          setTurnStart(0); // clear the persisted turn clock now the turn is done
          break;
      }
    },
    [flushStreaming, patch, refreshControls, updateToolCall, setTurnStart],
  );

  // Initial load + SSE subscription
  useEffect(() => {
    let closed = false;
    patch({ loading: true, error: null });

    api
      .session(path)
      .then((detail) => {
        if (closed) return;
        patch({
          messages: entriesToMessages(detail.entries),
          live: detail.live,
          name: detail.name ?? null,
          loading: false,
          // Seed todo/goal from persisted entries so the Tasks tab, footer count,
          // and widget reflect state even when the session isn't live (the live
          // broadcast only fires from a running runtime's lifecycle hooks).
          todo: todoFromEntries(detail.entries),
          goal: goalFromEntries(detail.entries),
        });
        // Load controls even when not live — for non-live, the last/default model is sent
        // as the input default, so the model selector doesn't look empty.
        refreshControls();
      })
      .catch((e) => !closed && patch({ error: String(e), loading: false }));

    // Event subscription is multiplexed over event-bus's single WebSocket. With one socket,
    // connections don't run out even with many open tabs, so keep all tabs subscribed (background
    // streams update in real time too). active is just for display, not used to gate subscriptions.
    const unsub = subscribeEvents(path, (ev) => {
      if (closed) return;
      handleEvent(ev);
    });

    return () => {
      closed = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    path, // Load controls even when not live — for non-live, the last/default model is sent
    // as the input default, so the model selector doesn't look empty.
    refreshControls,
    patch,
    handleEvent,
  ]);

  // Send a prompt (optimistically add the user message). images = array of data URLs (attachments).
  // deliverAs: while streaming, steer (inject immediately) / followUp (after the turn ends).
  // Neither steer nor followUp is added optimistically. steer is injected after the current work ends,
  // so its position may not match; it's shown at the correct position when the actual message_start(user) event arrives.
  const send = useCallback(
    async (text: string, force = false, images?: string[], deliverAs?: 'steer' | 'followUp') => {
      patch({ conflict: null, error: null });
      if (!deliverAs) {
        setState((s) => ({
          ...s,
          messages: [
            ...s.messages,
            { key: `u-${Date.now()}`, role: 'user', text, time: new Date().toISOString() },
          ],
        }));
      }
      try {
        await api.prompt(
          path,
          text,
          force,
          images,
          cwd,
          {
            model: draftModel ?? undefined,
            thinkingLevel: draftThinking ?? undefined,
          },
          deliverAs,
        );
        patch({ live: true });
        refreshControls();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const kind = e.body?.error === 'revoked' ? 'revoked' : 'locked';
          patch({ conflict: { kind, by: e.body?.current || e.body?.by } });
        } else {
          patch({ error: String(e) });
        }
      }
    },
    [path, cwd, patch, refreshControls, draftModel, draftThinking],
  );

  // Run a user `!`/`!!` bash command (TUI user_bash mirroring). excludeFromContext = `!!`.
  // The live block is added by the user_bash_start event; on conflict, surface it like send().
  const runBash = useCallback(
    async (command: string, excludeFromContext = false, force = false) => {
      patch({ conflict: null, error: null });
      try {
        await api.bash(path, command, excludeFromContext, cwd, force);
        patch({ live: true });
        refreshControls();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          if (e.body?.error === 'busy') {
            patch({ error: 'A command is already running' });
          } else {
            const kind = e.body?.error === 'revoked' ? 'revoked' : 'locked';
            patch({ conflict: { kind, by: e.body?.current || e.body?.by } });
          }
        } else {
          patch({ error: String(e) });
        }
      }
    },
    [path, cwd, patch, refreshControls],
  );

  // Replace queued messages (individual edit/delete). Send the whole surviving list to the server.
  const editQueue = useCallback(
    (steering: string[], followUp: string[]) => {
      patch({ queue: { steering, followUp } }); // optimistic update
      api.setQueue(path, steering, followUp).catch(() => undefined);
    },
    [path, patch],
  );

  // Force takeover (no resend after force takeover — just acquire the lock)
  const takeover = useCallback(
    async (lastText?: string) => {
      try {
        await api.open(path, true);
        patch({ conflict: null });
        refreshControls();
        if (lastText) await send(lastText, true);
      } catch (e) {
        patch({ error: String(e) });
      }
    },
    [path, patch, send, refreshControls],
  );

  // Common: control action wrapper that includes 409 handling.
  const runControl = useCallback(
    async (fn: () => Promise<SessionControls>) => {
      patch({ conflict: null, error: null });
      try {
        const controls = await fn();
        patch({ controls, live: controls.live, ...(controls.name ? { name: controls.name } : {}) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const kind = e.body?.error === 'revoked' ? 'revoked' : 'locked';
          patch({ conflict: { kind, by: e.body?.current || e.body?.by } });
        } else {
          patch({ error: String(e) });
        }
      }
    },
    [patch],
  );

  const setModel = useCallback(
    (provider: string, id: string, force = false) => {
      // If a live runtime exists, apply immediately; otherwise (before the first message) hold it as a draft.
      setDraftModel({ provider, id });
      if (stateRef.current.live) return runControl(() => api.setModel(path, provider, id, force));
      return Promise.resolve();
    },
    [path, runControl],
  );
  const setThinking = useCallback(
    (level: SessionControls['thinkingLevel'], force = false) => {
      if (!level) return Promise.resolve();
      setDraftThinking(level);
      if (stateRef.current.live) return runControl(() => api.setThinking(path, level, force));
      return Promise.resolve();
    },
    [path, runControl],
  );
  const rename = useCallback(
    (name: string, force = false) => runControl(() => api.rename(path, name, force)),
    [path, runControl],
  );

  const clearError = useCallback(() => patch({ error: null }), [patch]);

  // Abort the in-progress response.
  const abort = useCallback(() => {
    interruptedRef.current = true;
    api.abort(path).catch(() => undefined);
  }, [path]);

  // Tear down the runtime and release the lock (keep the tab). The session goes back to read-only.
  const shutdown = useCallback(async () => {
    try {
      await api.dispose(path); // wait until the server tears down the runtime and releases the lock
    } catch {
      /* best-effort */
    }
    patch({ live: false, streaming: false });
  }, [path, patch]);

  // UI bridge response (send the confirm/select/input dialog result to the backend).
  const respondUi = useCallback(
    (id: string, value: unknown) => {
      patch({ uiRequest: null });
      api.uiResponse(path, id, value).catch(() => undefined);
    },
    [path, patch],
  );

  // Shared by the info panel and composer: current model/effort. When live, controls is the
  // source of truth (draft is stale). When not live, the user's draft selection wins over the
  // controls snapshot (which only carries the last/default model as an input default) — otherwise
  // a pre-first-message model/effort change wouldn't show even though it's applied on the first prompt.
  const controlsModel = state.controls?.model
    ? { provider: state.controls.model.provider, id: state.controls.model.id }
    : null;
  const effectiveModel = state.live ? controlsModel : (draftModel ?? controlsModel);
  const effectiveThinking = state.live
    ? (state.controls?.thinkingLevel ?? null)
    : (draftThinking ?? state.controls?.thinkingLevel ?? null);

  return {
    state,
    send,
    runBash,
    takeover,
    clearError,
    setModel,
    setThinking,
    rename,
    refreshControls,
    abort,
    shutdown,
    editQueue,
    respondUi,
    effectiveModel,
    effectiveThinking,
    turnStartRef,
  };
}
