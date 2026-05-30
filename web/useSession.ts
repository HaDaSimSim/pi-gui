// 한 세션 탭의 라이브 상태를 관리하는 훅.
//
// 동작:
//   1. 마운트 시 기존 엔트리 로드 (스크롤백) — 런타임/락 불필요
//   2. SSE 구독 — 보기 전용, 락 불필요
//   3. prompt 전송 시 백엔드가 런타임+락을 띄움. 409 면 락 충돌 상태로 전이
//   4. 스트리밍 델타(text/thinking/tool)를 누적해 화면 메시지로 합성

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  subscribeEvents,
  ApiError,
  type SessionEntry,
  type LockRecord,
  type SessionControls,
} from "./api";

export type ChatRole = "user" | "assistant" | "tool" | "system";

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
}

// 세션 파일 엔트리(스크롤백)를 화면 메시지로 변환.
function entriesToMessages(entries: SessionEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
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

export function useSession(path: string) {
  const [state, setState] = useState<SessionState>({
    messages: [],
    streaming: false,
    live: false,
    conflict: null,
    error: null,
    loading: true,
    controls: null,
  });

  // 스트리밍 중 누적 중인 assistant 메시지 (이벤트로 갱신)
  const streamingRef = useRef<ChatMessage | null>(null);

  const patch = useCallback((p: Partial<SessionState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

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

  // 컨트롤 스냅샷을 다시 읽는다 (라이브일 때만 의미 있음).
  const refreshControls = useCallback(() => {
    api
      .controls(path)
      .then((controls) => patch({ controls }))
      .catch(() => undefined);
  }, [path, patch]);

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
          loading: false,
        });
        if (detail.live) refreshControls();
      })
      .catch((e) => !closed && patch({ error: String(e), loading: false }));

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
        case "agent_start":
          patch({ streaming: true });
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
          const sm = streamingRef.current;
          if (sm) {
            sm.toolCalls = sm.toolCalls || [];
            if (!sm.toolCalls.find((t) => t.id === ev.toolCallId)) {
              sm.toolCalls.push({
                id: ev.toolCallId,
                name: ev.toolName,
                args: ev.args,
                status: "running",
              });
            }
            flushStreaming();
          }
          break;
        }
        case "tool_execution_end": {
          const sm = streamingRef.current;
          const tc = sm?.toolCalls?.find((t) => t.id === ev.toolCallId);
          if (tc) {
            tc.status = ev.isError ? "error" : "done";
            tc.resultText = contentToText(ev.result?.content);
            flushStreaming();
          }
          break;
        }
        case "message_end":
          if (streamingRef.current) {
            streamingRef.current.streaming = false;
            flushStreaming();
            streamingRef.current = null;
          }
          break;
        case "agent_end":
          patch({ streaming: false });
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
        await api.prompt(path, text, force, images);
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
    [path, patch, refreshControls],
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
        patch({ controls, live: controls.live });
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
    (provider: string, id: string, force = false) => runControl(() => api.setModel(path, provider, id, force)),
    [path, runControl],
  );
  const setThinking = useCallback(
    (level: SessionControls["thinkingLevel"], force = false) =>
      level ? runControl(() => api.setThinking(path, level, force)) : Promise.resolve(),
    [path, runControl],
  );
  const rename = useCallback(
    (name: string, force = false) => runControl(() => api.rename(path, name, force)),
    [path, runControl],
  );

  const clearError = useCallback(() => patch({ error: null }), [patch]);

  return { state, send, takeover, clearError, setModel, setThinking, rename, refreshControls };
}
