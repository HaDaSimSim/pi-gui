// 서브에이전트 실행 뷰 — info 패널의 "Subagents" 탭에서 렌더.
// subagents extension 이 세션 파일에 남긴 subagent-run 커스텀 엔트리를 읽어 표시.

import { useState } from "react";
import { ChevronRight, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SubagentRunView } from "./use-session";

function statusDot(status: SubagentRunView["status"]): string {
  return status === "running" ? "bg-amber-500" : status === "failed" ? "bg-destructive" : "bg-emerald-500";
}

export function SubagentRunCard({ run, defaultOpen, onOpen }: { run: SubagentRunView; defaultOpen?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-lg border p-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className={cn("size-2 shrink-0 rounded-full", statusDot(run.status))} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          {onOpen ? (
            <button
              onClick={onOpen}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="open as chat"
              title="open as chat"
            >
              <Maximize2 className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{run.agent}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{run.runId}</span>
          {run.turns.length > 1 ? <span>{run.turns.length} turns</span> : null}
          {run.cost != null ? <span>${run.cost.toFixed(4)}</span> : null}
        </div>
        <CollapsibleContent className="mt-2.5 flex flex-col gap-2.5">
          <div className="rounded-md bg-muted/50 p-2 text-xs leading-relaxed text-muted-foreground">{run.task}</div>
          {run.turns.map((tn, i) => (
            <div key={i} className="border-l-2 border-border pl-2.5">
              {run.turns.length > 1 ? (
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  turn {i + 1}
                </div>
              ) : null}
              {tn.error ? (
                <div className="text-xs text-destructive">{tn.error}</div>
              ) : tn.finalOutput ? (
                <div className="whitespace-pre-wrap text-sm leading-relaxed">{tn.finalOutput.slice(0, 8000)}</div>
              ) : (
                <div className="text-xs text-muted-foreground">…</div>
              )}
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
