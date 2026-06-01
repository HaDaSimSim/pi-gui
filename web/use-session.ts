// 한 세션 탭의 라이브 상태를 관리하는 훅.
//
// 동작:
//   1. 마운트 시 기존 엔트리 로드 (스크롤백) — 런타임/락 불필요
//   2. SSE 구독 — 보기 전용, 락 불필요
//   3. prompt 전송 시 백엔드가 런타임+락을 띄움. 409 면 락 충돌 상태로 전이
//   4. 스트리밍 델타(text/thinking/tool)를 누적해 화면 메시지로 합성

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { reportStreaming } from "./config";
import {
  api,
  subscribeEvents,
  ApiError,
  type SessionEntry,
  type LockRecord,
  type SessionControls,
  type ThinkingLevel,
} from "./api";

export type ChatRole = "user" | "assistant" | "tool" | "system" | "subagent";

export interface SubagentTranscriptItem {
  kind: "thinking" | "text" | "toolCall" | "toolResult";
  text: string;
  toolName?: string;
}

export interface SubagentRunView {
  runId: string;
  agent: string;
  title: string;
  task: string;
  status: "running" | "done" | "failed";
  model?: string;
  turns: { prompt: string; finalOutput: string; error?: string; transcript?: SubagentTranscriptItem[] }[];
  cost?: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "error";
  resultText?: string;
}

export interface ChatMessage {
  key: string;
  role: ChatRole;
  text: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  streaming?: boolean;
  model?: string;
  time?: string; // ISO timestamp (메타 표시용)
  elapsedMs?: number; // 응답 소요 시간 (agent_start → message_end)
  interrupted?: boolean; // 사용자가 중단(abort)한 턴인지
  subagentRun?: SubagentRunView; // subagents extension 의 subagent-run 엔트리
}

export interface LockConflict {
  kind: "locked" | "revoked";
  by?: LockRecord;
}

export interface SessionState {
  messages: ChatMessage[];
  streaming: boolean;
  live: boolean;
  conflict: LockConflict | null;
  error: string | null;
  loading: boolean;
  controls: SessionControls | null; // 모델/효율/컨텍스트/이름 스냅샷 (info 패널용)
  name: string | null; // 세션 이름 (스크롤백 + rename + 라이브 반영)
  uiRequest: UiRequest | null; // extension 의 ctx.ui.confirm/select/input 요청 (브릿지)
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
  kind: "select" | "confirm" | "input" | "editor" | "questionnaire" | "btw";
  title: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  questions?: UiQuestion[];
  answer?: string;
}

// 세션 파일 엔트리(스크롤백)를 화면 메시지로 변환.
function entriesToMessages(entries: SessionEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // subagents extension 은 한 run 을 여러 번 append 한다(시작→턴마다→완료).
  // 같은 runId 는 최신 스냅샷으로 덮어쓴다 (최초 등장 위치 유지) — TUI 와 동일.
  const subagentIdx = new Map<string, number>();
  for (const e of entries) {
    // subagents extension 의 subagent-run 커스텀 엔트리 (type:"custom").
    if (e.type === "custom" && (e as any).customType === "subagent-run") {
      const r = (e as any).data as
        | {
            runId: string;
            agent: string;
            title: string;
            task: string;
            status: "running" | "done" | "failed";
            model?: string;
            usage?: { cost?: number };
            turns?: { prompt: string; finalOutput: string; error?: string; transcript?: { kind: string; text: string; toolName?: string }[] }[];
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
              kind: it.kind as "thinking" | "text" | "toolCall" | "toolResult",
              text: it.text,
              toolName: it.toolName,
            })),
          })),
        };
        const existing = subagentIdx.get(r.runId);
        if (existing != null) {
          // 같은 run 의 최신 스냅샷으로 제자리 갱신 (중복 카드 방지).
          out[existing] = { ...out[existing], subagentRun: view };
        } else {
          subagentIdx.set(r.runId, out.length);
          out.push({
            key: e.id,
            role: "subagent",
            text: "",
            time: e.timestamp,
            subagentRun: view,
          });
        }
      }
      continue;
    }
    // ui-cosmetics 의 turn-meta 커스텀 엔트리: 직전 assistant 턴의 소요 시간(초).
    // 직전 assistant 메시지에 elapsedMs 로 붙인다.
    if (e.type === "custom_message" && (e as any).customType === "turn-meta") {
      const details = (e as any).details as { elapsed?: number; model?: string } | undefined;
      if (details?.elapsed != null) {
        const lastAssistant = [...out].reverse().find((x) => x.role === "assistant");
        if (lastAssistant) {
          lastAssistant.elapsedMs = details.elapsed * 1000;
          if (!lastAssistant.model && details.model) lastAssistant.model = details.model;
        }
      }
      continue;
    }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const role = m.role;
    if (role === "user") {
      out.push({ key: e.id, role: "user", text: contentToText(m.content), time: e.timestamp });
    } else if (role === "assistant") {
      const text = extractAssistantText(m.content);
      const thinking = extractThinking(m.content);
      const toolCalls = extractToolCalls(m.content);
      out.push({
        key: e.id,
        role: "assistant",
        text,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        model: typeof m.model === "string" ? m.model : undefined,
        time: e.timestamp,
      });
    } else if (role === "toolResult") {
      // 직전 assistant 의 toolCall 에 결과를 붙인다
      const last = [...out].reverse().find((x) => x.role === "assistant" && x.toolCalls?.length);
      const callId = (m as any).toolCallId;
      const tc = last?.toolCalls?.find((t) => t.id === callId);
      if (tc) {
        tc.status = (m as any).isError ? "error" : "done";
        tc.resultText = contentToText(m.content);
      }
    }
  }
  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return contentToText(content);
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
}
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "thinking").map((b: any) => b.thinking).join("");
}
function extractToolCalls(content: unknown): ToolCallView[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "toolCall")
    .map((b: any) => ({ id: b.id, name: b.name, args: b.arguments, status: "done" as const }));
}

export function useSession(path: string, cwd?: string) {
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
  });

  // 스트리밍 중 누적 중인 assistant 메시지 (이벤트로 갱신)
  const streamingRef = useRef<ChatMessage | null>(null);
  // 턴 시작 시각 (agent_start) — message_end 에서 소요 시간 계산용 (ui-cosmetics 방식)
  const turnStartRef = useRef<number>(0);
  // 사용자 중단(abort) 플래그 — abort 호출 시 set, 다음 agent_end 에서 소비해 마지막 메시지를 interrupted 로 표시.
  const interruptedRef = useRef(false);

  // 첫 메시지 전 draft 모델/효율 (런타임이 없어 API 로 못 바꾸므로 로컬에 들고 있다가
  // 첫 prompt 에 함께 보낸다). 런타임이 생기면 controls 가 진짜 값을 들고 온다.
  const [draftModel, setDraftModel] = useState<{ provider: string; id: string } | null>(null);
  const [draftThinking, setDraftThinking] = useState<ThinkingLevel | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // 최신 state 를 콜백에서 읽기 위한 ref (setModel/setThinking 의 live 판정용).
  const stateRef = useRef(state);
  stateRef.current = state;

  // 스트리밍 메시지를 messages 배열 끝에 반영
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

  // 툴 호출을 id 로 찾아 갱신한다. 툴은 message_end 이후에 실행되므로(tool_execution_*)
  // 그 시점엔 streamingRef 가 이미 null 일 수 있다. 그래서 스트리밍 중이면 streamingRef,
  // 아니면 이미 커밋된 messages 에서 찾아 수정한다. (create 가 있으면 없을 때 새로 추가.)
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
          tc = { id: create.id, name: create.name, args: create.args, status: "running" };
          sm.toolCalls.push(tc);
        }
        if (tc) {
          mutate(tc);
          flushStreaming();
          return;
        }
      }
      // 커밋된 메시지에서 찾아 수정.
      setState((s) => {
        const msgs = [...s.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== "assistant" || !m.toolCalls?.length) continue;
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
        // 못 찾았고 create 가 있으면 마지막 assistant 에 추가.
        if (create) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              const tc: ToolCallView = { id: create.id, name: create.name, args: create.args, status: "running" };
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

  // 컨트롤 스냅샷을 다시 읽는다 (라이브일 때만 의미 있음).
  const refreshControls = useCallback(() => {
    api
      .controls(path)
      .then((controls) => patch({ controls, ...(controls.name ? { name: controls.name } : {}) }))
      .catch(() => undefined);
  }, [path, patch]);

  // 스트리밍 상태를 Tauri 에 보고 (quit 확인용 busy 카운트). 언마운트 시 감소.
  useEffect(() => {
    if (!state.streaming) return;
    reportStreaming(true);
    return () => reportStreaming(false);
  }, [state.streaming]);

  // 초기 로드 + SSE 구독
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
        });
        // 라이브가 아니어도 controls 를 불러온다 — 비-라이브엔 마지막/기본 모델을
        // input default 로 내려주므로, 모델 셀렉터가 비어보이지 않게 한다.
        refreshControls();
      })
      .catch((e) => !closed && patch({ error: String(e), loading: false }));

    // 이벤트 구독은 event-bus 의 단일 WebSocket 으로 멀티플렉싱된다. 소켓 1개라
    // 탭을 많이 열어도 연결이 고갈되지 않으므로, 모든 탭을 구독 유지한다(백그라운드
    // 스트림도 실시간 반영). active 는 표시용일 뿐 구독 게이팅에 쓰지 않는다.
    const unsub = subscribeEvents(path, (ev) => {
      if (closed) return;
      handleEvent(ev);
    });

    return () => {
      closed = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // SSE 이벤트 처리 — 스트리밍 델타 누적
  const handleEvent = useCallback(
    (ev: any) => {
      switch (ev.type) {
        case "_connected":
          patch({ live: ev.live, streaming: ev.streaming });
          break;
        case "ui_request":
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
          break;
        case "ui_cancel":
          // 원격(텔레그램) 응답이 먼저 와서 호스트가 닫으라고 함 → 해당 다이얼로그만 닫는다.
          setState((s) => (s.uiRequest && s.uiRequest.id === ev.id ? { ...s, uiRequest: null } : s));
          break;
        case "ui_notify":
          toast[ev.level === "error" ? "error" : ev.level === "warning" ? "warning" : "info"](ev.message);
          break;
        case "session_error":
          // 세션 단위 에러(프롬프트/extension 등) → 에러 배너 + 토스트.
          patch({ streaming: false, error: ev.message || "session error" });
          toast.error(ev.message || "session error");
          streamingRef.current = null;
          break;
        case "backend_error":
          // 백엔드 전역 에러(uncaughtException 등) → 토스트로 경고.
          toast.error(`Backend error: ${ev.message || "unknown"}`);
          break;
        case "session_info_changed":
          // 세션 이름이 바뀌면(첫 메시지 후 자동 명명 등) 라이브 반영.
          if (ev.name) patch({ name: ev.name });
          break;
        case "thinking_level_changed":
          refreshControls();
          break;
        case "agent_start":
          patch({ streaming: true });
          turnStartRef.current = Date.now();
          break;
        case "message_start": {
          const msg = ev.message;
          if (msg?.role === "assistant") {
            streamingRef.current = {
              key: `stream-${Date.now()}`,
              role: "assistant",
              text: "",
              streaming: true,
              time: new Date().toISOString(),
            };
            flushStreaming();
          }
          break;
        }
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (!streamingRef.current) {
            streamingRef.current = {
              key: `stream-${Date.now()}`,
              role: "assistant",
              text: "",
              streaming: true,
              time: new Date().toISOString(),
            };
          }
          const sm = streamingRef.current;
          if (d?.type === "text_delta") sm.text += d.delta;
          else if (d?.type === "thinking_delta") sm.thinking = (sm.thinking || "") + d.delta;
          else if (d?.type === "toolcall_end" && d.toolCall) {
            sm.toolCalls = sm.toolCalls || [];
            sm.toolCalls.push({
              id: d.toolCall.id,
              name: d.toolCall.name,
              args: d.toolCall.arguments,
              status: "running",
            });
          }
          flushStreaming();
          break;
        }
        case "tool_execution_start": {
          updateToolCall(ev.toolCallId, (tc) => {
            tc.status = "running";
          }, { id: ev.toolCallId, name: ev.toolName, args: ev.args });
          break;
        }
        case "tool_execution_end": {
          updateToolCall(ev.toolCallId, (tc) => {
            tc.status = ev.isError ? "error" : "done";
            tc.resultText = contentToText(ev.result?.content);
          });
          break;
        }
        case "message_end":
          if (streamingRef.current) {
            streamingRef.current.streaming = false;
            // 주의: 툴은 message_end 이후에 실행된다(tool_execution_*). 여기서 running 을
            // error 로 강제하면 아직 결과가 안 온 툴을 잘못 실패로 표시한다. 건드리지 않는다.
            flushStreaming();
            streamingRef.current = null;
          }
          break;
        case "agent_end":
          // 턴 종료: 마지막 assistant 메시지에만 메타(소요시간)를 붙인다.
          // 턴이 끝났는데도 running 인 툴은 그제서야 실패로 간주(중단 등).
          if (streamingRef.current) {
            flushStreaming();
          }
          setState((s) => {
            const msgs = [...s.messages];
            const wasInterrupted = interruptedRef.current;
            // 중단/종료 직후 생긴 빈 assistant 메시지(텍스트·thinking·툴 없음)는 버린다.
            while (
              msgs.length > 0 &&
              msgs[msgs.length - 1].role === "assistant" &&
              !msgs[msgs.length - 1].text.trim() &&
              !msgs[msgs.length - 1].thinking &&
              !msgs[msgs.length - 1].toolCalls?.length &&
              !msgs[msgs.length - 1].subagentRun
            ) {
              msgs.pop();
            }
            // 내용 있는 마지막 assistant 메시지에 메타/중단 표시.
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant") {
                const tcs = msgs[i].toolCalls?.map((t) =>
                  wasInterrupted && t.status === "running" ? { ...t, status: "error" as const } : t,
                );
                msgs[i] = {
                  ...msgs[i],
                  elapsedMs: turnStartRef.current > 0 ? Date.now() - turnStartRef.current : msgs[i].elapsedMs,
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
          refreshControls(); // 턴 끝난 뒤 컨텍스트/비용 갱신
          break;
      }
    },
    [flushStreaming, patch, refreshControls],
  );

  // 프롬프트 전송 (낙관적으로 user 메시지 추가). images = data URL 배열(첨부).
  const send = useCallback(
    async (text: string, force = false, images?: string[]) => {
      patch({ conflict: null, error: null });
      setState((s) => ({
        ...s,
        messages: [...s.messages, { key: `u-${Date.now()}`, role: "user", text, time: new Date().toISOString() }],
      }));
      try {
        await api.prompt(path, text, force, images, cwd, {
          model: draftModel ?? undefined,
          thinkingLevel: draftThinking ?? undefined,
        });
        patch({ live: true });
        refreshControls();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const kind = e.body?.error === "revoked" ? "revoked" : "locked";
          patch({ conflict: { kind, by: e.body?.current || e.body?.by } });
        } else {
          patch({ error: String(e) });
        }
      }
    },
    [path, cwd, patch, refreshControls, draftModel, draftThinking],
  );

  // 강제로 가져오기 (force takeover 후 재전송 X — 그냥 락만 확보)
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

  // 공통: 409 처리를 포함한 컨트롤 액션 래퍼.
  const runControl = useCallback(
    async (fn: () => Promise<SessionControls>) => {
      patch({ conflict: null, error: null });
      try {
        const controls = await fn();
        patch({ controls, live: controls.live, ...(controls.name ? { name: controls.name } : {}) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const kind = e.body?.error === "revoked" ? "revoked" : "locked";
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
      // 라이브 런타임이 있으면 즉시 반영, 없으면(첫 메시지 전) draft 로 든다.
      setDraftModel({ provider, id });
      if (stateRef.current.live) return runControl(() => api.setModel(path, provider, id, force));
      return Promise.resolve();
    },
    [path, runControl],
  );
  const setThinking = useCallback(
    (level: SessionControls["thinkingLevel"], force = false) => {
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

  // 진행 중인 응답 중단.
  const abort = useCallback(() => {
    interruptedRef.current = true;
    api.abort(path).catch(() => undefined);
  }, [path]);

  // 런타임 내리고 락 해제 (탭은 유지). 세션은 읽기 전용으로 돌아간다.
  const shutdown = useCallback(async () => {
    try {
      await api.dispose(path); // 서버가 런타임 내리고 락 release 할 때까지 대기
    } catch {
      /* best-effort */
    }
    patch({ live: false, streaming: false });
  }, [path, patch]);

  // UI 브릿지 응답 (confirm/select/input 다이얼로그의 결과를 백엔드로).
  const respondUi = useCallback(
    (id: string, value: unknown) => {
      patch({ uiRequest: null });
      api.uiResponse(path, id, value).catch(() => undefined);
    },
    [path, patch],
  );

  // info 패널 · 컴포저 공용: 현재 모델/효율 — 라이브면 controls, 아니면 draft.
  const effectiveModel = state.controls?.model
    ? { provider: state.controls.model.provider, id: state.controls.model.id }
    : draftModel;
  const effectiveThinking = state.controls?.thinkingLevel ?? draftThinking;

  return {
    state,
    send,
    takeover,
    clearError,
    setModel,
    setThinking,
    rename,
    refreshControls,
    abort,
    shutdown,
    respondUi,
    effectiveModel,
    effectiveThinking,
  };
}
