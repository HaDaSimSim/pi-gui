// 채팅 메시지 렌더 — 일반적인 채팅 UI (말풍선).
//
// user: 오른쪽 정렬 강조 버블. assistant: 왼쪽, 배경 옅게.
// thinking / tool call 은 접을 수 있는 보조 블록.

import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import type { ChatMessage, ToolCallView } from "./useSession";
import { useT } from "./i18n";

// tool call 인자에서 사람이 읽을 한 줄 요약을 뽑는다.
// 흔한 키(파일 경로/명령어/패턴 등)를 우선 사용하고, 없으면 첫 스칼라 값.
function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const a = args as Record<string, unknown>;
  const prefer = [
    "path",
    "file_path",
    "filePath",
    "command",
    "cmd",
    "pattern",
    "query",
    "url",
    "name",
    "description",
  ];
  for (const k of prefer) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // 폴백: 첫 스칼라 값
  for (const v of Object.values(a)) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

function oneLine(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function ToolCall({ tc }: { tc: ToolCallView }) {
  const { t } = useT();
  const dot =
    tc.status === "running" ? "#f0a020" : tc.status === "error" ? "#e0506a" : "#3aa76d";
  const argStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}, null, 2);
  const summary = oneLine(summarizeArgs(tc.args));

  // 컴팩트 헤더: 작은 상태 점 + 툴 이름(mono) + 흐린 한 줄 요약
  const header = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, minWidth: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0 }} />
      <span className="piweb-mono" style={{ fontWeight: 600 }}>
        {tc.name}
      </span>
      {summary ? (
        <span
          className="piweb-mono"
          style={{
            opacity: 0.55,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </span>
      ) : null}
    </span>
  );

  return (
    <div style={{ marginTop: 4 }}>
      <ExpandableSection variant="footer" headerText={header}>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 2 }}>args</div>
        <pre className="piweb-mono" style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.85 }}>
          {argStr.slice(0, 2000)}
        </pre>
        {tc.resultText ? (
          <>
            <div style={{ fontSize: 11, opacity: 0.55, margin: "6px 0 2px" }}>
              {t("message.done")}
            </div>
            <pre
              className="piweb-mono"
              style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.7 }}
            >
              {tc.resultText.slice(0, 2000)}
            </pre>
          </>
        ) : null}
      </ExpandableSection>
    </div>
  );
}

export function MessageView({ msg }: { msg: ChatMessage }) {
  const { t } = useT();
  const isUser = msg.role === "user";

  const timeStr = msg.time
    ? new Date(msg.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";

  // thinking: 헤더 없이 작은 회색 글씨 preview 의 expandable.
  const thinkingBlock = msg.thinking ? (
    <details className="piweb-thinking" style={{ marginBottom: 6 }}>
      <summary
        style={{
          fontSize: 11,
          opacity: 0.5,
          cursor: "pointer",
          listStyle: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {oneLine(msg.thinking, 80)}
      </summary>
      <pre
        className="piweb-mono"
        style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.6 }}
      >
        {msg.thinking}
      </pre>
    </details>
  ) : null;

  // ── user: 버블 유지 (우측 정렬) ──
  if (isUser) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: "100%" }}>
        <div
          style={{
            background: "var(--color-background-button-primary-default, #006ce0)",
            color: "#fff",
            borderRadius: "14px 14px 4px 14px",
            padding: "10px 14px",
            maxWidth: "60%",
          }}
        >
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>{msg.text}</div>
        </div>
        {timeStr ? (
          <div style={{ fontSize: 10, opacity: 0.45, margin: "2px 4px 0 0" }}>{timeStr}</div>
        ) : null}
      </div>
    );
  }

  // ── assistant: 버블 없이 평문 + 아래 메타(모델 · 시간) ──
  const meta = [
    msg.model ? t("message.assistantModel", { model: msg.model }) : t("message.assistant"),
    timeStr,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", width: "100%" }}>
      <div style={{ width: "100%" }}>
        {thinkingBlock}

        {msg.text ? (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>{msg.text}</div>
        ) : !msg.thinking && !msg.toolCalls?.length ? (
          <Box color="text-status-inactive">…</Box>
        ) : null}

        {msg.toolCalls?.map((tc) => <ToolCall key={tc.id} tc={tc} />)}
      </div>

      {/* 메타: 메시지 아래 작은 회색. 스트리밍 중이면 표시. */}
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
        <span>{meta}</span>
        {msg.streaming ? <StatusIndicator type="loading">{t("message.streaming")}</StatusIndicator> : null}
      </div>
    </div>
  );
}
