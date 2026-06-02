// 채팅 메시지 렌더 — 일반 채팅 UI.
//
// user: 우측 정렬 강조 버블(최대 60%). assistant: 버블 없이 평문 + 하단 메타(모델·시간).
// thinking: 헤더 없이 작은 회색 미리보기 expandable. tool call: 컴팩트 한 줄 요약.

import { Loader2, ChevronRight, FileText, FilePen, Terminal, Search, Globe, Wrench, FolderTree, Check, X as XIcon, ListTodo, Ban } from "lucide-react";
import { createContext, memo, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Markdown } from "./markdown";
import { SubagentRunCard } from "./subagent-run";
import type { ChatMessage, ToolCallView } from "./use-session";

import { useT } from "./i18n";

// 인라인 서브에이전트 카드에서 모달을 열기 위한 콜백 컨텍스트.
export const SubagentOpenContext = createContext<((runId: string) => void) | null>(null);

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

// 툴 이름 → 아이콘. 알려진 툴은 전용 아이콘, 아니면 Wrench.
function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (/(^|_)(read|view|cat|open)/.test(n)) return FileText;
  if (/(write|edit|patch|apply|create|append|replace)/.test(n)) return FilePen;
  if (/(bash|shell|exec|run|command|terminal)/.test(n)) return Terminal;
  if (/(grep|search|find|ripgrep|rg)/.test(n)) return Search;
  if (/(fetch|http|web|url|browse|curl)/.test(n)) return Globe;
  if (/(ls|list|tree|glob|dir)/.test(n)) return FolderTree;
  if (/(todo|task|plan)/.test(n)) return ListTodo;
  return Wrench;
}

function ToolCall({ tc }: { tc: ToolCallView }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tc.name);
  const argStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}, null, 2);
  const summary = oneLine(summarizeArgs(tc.args));
  const running = tc.status === "running";
  const error = tc.status === "error";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-0.5">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
          running
            ? "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10"
            : error
              ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
              : "border-emerald-500/25 bg-emerald-500/5 hover:bg-emerald-500/10",
        )}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded",
            running ? "text-amber-500" : error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        </span>
        <span className="shrink-0 font-mono font-semibold text-foreground">{tc.name}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        {!running ? (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-full",
              error ? "bg-destructive/15 text-destructive" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
            )}
          >
            {error ? <XIcon className="size-2.5" /> : <Check className="size-2.5" />}
          </span>
        ) : null}
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-2.5 border-l border-border/60 pl-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">args</div>
          <pre className="m-0 overflow-x-auto rounded-md bg-muted/50 p-2.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/80">
            {argStr.slice(0, 2000)}
          </pre>
          {tc.resultText ? (
            <>
              <div className="mt-2.5 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("message.done")}
              </div>
              <pre className="m-0 max-h-72 overflow-auto rounded-md bg-muted/50 p-2.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                {tc.resultText.slice(0, 4000)}
              </pre>
            </>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageViewImpl({ msg }: { msg: ChatMessage }) {
  const { t } = useT();
  const isUser = msg.role === "user";

  // subagent run 은 채팅 흐름 안에 인라인으로 렌더한다 (그 세션에서 둔 서브에이전트).
  // info 패널 Subagents 탭에도 모아 보이지만, 대화 맥락에서 바로 보이는 게 더 자연스럽다.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const openSubagent = useContext(SubagentOpenContext);
  if (msg.subagentRun) {
    return (
      <div className="w-full">
        <SubagentRunCard run={msg.subagentRun} onOpen={openSubagent ? () => openSubagent(msg.subagentRun!.runId) : undefined} />
      </div>
    );
  }

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

  // 메타 표시 규칙: 턴이 끝난 마지막 메시지(elapsedMs 설정됨)에만 표시.
  // 스트리밍 중이면 스피너만, 중간 메시지(툴 호출 사이)에는 메타를 안 단다.
  const showMeta = msg.elapsedMs != null;
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
      {msg.interrupted ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-500">
          <Ban className="size-3.5" /> {t("message.interrupted")}
        </div>
      ) : null}
      {showMeta || msg.streaming ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          {showMeta ? <span>{meta}</span> : null}
          {msg.streaming ? <Loader2 className="size-3.5 animate-spin" /> : null}
        </div>
      ) : null}
    </div>
  );
}

// 메모이제이션: 완료된 메시지가 다른 메시지의 갱신 때문에 markdown 을 재파싱하지
// 않도록 한다 (큰 세션 렉의 주범). 내용 관련 필드가 바뀔 때만 재렌더.
function toolSig(tcs?: ToolCallView[]): string {
  if (!tcs?.length) return "";
  return tcs.map((t) => `${t.id}:${t.status}:${t.resultText ? 1 : 0}`).join("|");
}
export const MessageView = memo(MessageViewImpl, (a, b) => {
  const x = a.msg;
  const y = b.msg;
  return (
    x.key === y.key &&
    x.text === y.text &&
    x.thinking === y.thinking &&
    x.streaming === y.streaming &&
    x.interrupted === y.interrupted &&
    x.model === y.model &&
    x.elapsedMs === y.elapsedMs &&
    x.time === y.time &&
    x.subagentRun === y.subagentRun &&
    toolSig(x.toolCalls) === toolSig(y.toolCalls)
  );
});
