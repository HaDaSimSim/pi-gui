// 채팅 메시지 렌더 — 일반 채팅 UI.
//
// user: 우측 정렬 강조 버블(최대 60%). assistant: 버블 없이 평문 + 하단 메타(모델·시간).
// thinking: 헤더 없이 작은 회색 미리보기 expandable. tool call: 컴팩트 한 줄 요약.

import { Loader2, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Markdown } from "./markdown";
import type { ChatMessage, ToolCallView } from "./use-session";
import { useT } from "./i18n";

// tool call 인자에서 사람이 읽을 한 줄 요약을 뽑는다.
function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const a = args as Record<string, unknown>;
  const prefer = ["path", "file_path", "filePath", "command", "cmd", "pattern", "query", "url", "name", "description"];
  for (const k of prefer) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
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

// 소요 시간 포맷 (ui-cosmetics 와 동일한 감각): 950ms / 3.2s / 2m 15s
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function ToolCall({ tc }: { tc: ToolCallView }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const dotColor =
    tc.status === "running" ? "bg-amber-500" : tc.status === "error" ? "bg-destructive" : "bg-emerald-500";
  const argStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}, null, 2);
  const summary = oneLine(summarizeArgs(tc.args));

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 border-l-2 border-border/60 pl-2">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent">
        <span className={cn("size-1.5 shrink-0 rounded-full", dotColor)} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">tool</span>
        <span className="font-mono font-semibold">{tc.name}</span>
        {summary ? <span className="truncate font-mono text-muted-foreground">{summary}</span> : null}
        <ChevronRight
          className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 pl-1">
          <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">args</div>
          <pre className="m-0 overflow-x-auto rounded bg-muted/50 p-2 whitespace-pre-wrap font-mono text-[11px] text-foreground/80">
            {argStr.slice(0, 2000)}
          </pre>
          {tc.resultText ? (
            <>
              <div className="mb-0.5 mt-2 text-[11px] font-medium text-muted-foreground">{t("message.done")}</div>
              <pre className="m-0 overflow-x-auto rounded bg-muted/50 p-2 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {tc.resultText.slice(0, 2000)}
              </pre>
            </>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MessageView({ msg }: { msg: ChatMessage }) {
  const { t } = useT();
  const isUser = msg.role === "user";

  // subagent run 은 info 패널의 Subagents 탭에서 렌더한다 — 채팅 흐름에서는 숨긴다.
  if (msg.subagentRun) return null;

  const timeStr = msg.time
    ? new Date(msg.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";

  // thinking: 앞에 "Thinking" 라벨 + 작은 회색 미리보기 expandable. (tool call 과 달리 보더 없이 라벨로 구분)
  const thinkingBlock = msg.thinking ? (
    <details className="piweb-thinking mb-1.5">
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <span className="shrink-0 font-medium italic">Thinking</span>
        <span className="truncate">{oneLine(msg.thinking, 80)}</span>
      </summary>
      <pre className="m-0 mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground/60">
        {msg.thinking}
      </pre>
    </details>
  ) : null;

  // ── user: 버블 유지 (우측 정렬, 최대 60%) ──
  if (isUser) {
    return (
      <div className="flex w-full flex-col items-end">
        <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-primary-foreground">
          <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</div>
        </div>
        {timeStr ? <div className="mt-1.5 mr-1 text-xs text-muted-foreground/70">{timeStr}</div> : null}
      </div>
    );
  }

  // ── assistant: 버블 없이 평문 + 하단 메타 ──
  const meta = [
    msg.model ? t("message.assistantModel", { model: msg.model }) : t("message.assistant"),
    msg.elapsedMs != null ? formatElapsed(msg.elapsedMs) : "",
    timeStr,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex w-full flex-col items-start">
      <div className="w-full leading-relaxed">
        {thinkingBlock}
        {msg.text ? (
          <Markdown text={msg.text} />
        ) : !msg.thinking && !msg.toolCalls?.length ? (
          <div className="text-muted-foreground">…</div>
        ) : null}
        {msg.toolCalls?.map((tc) => <ToolCall key={tc.id} tc={tc} />)}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground/70">
        <span>{meta}</span>
        {msg.streaming ? <Loader2 className="size-3.5 animate-spin" /> : null}
      </div>
    </div>
  );
}
