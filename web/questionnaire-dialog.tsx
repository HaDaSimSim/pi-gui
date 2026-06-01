// questionnaire 전용 다이얼로그 — question 익스텐션의 구조화된 질문을 받아
// 탭(여러 질문) + 옵션(라디오/멀티셀렉트 체크) + 자유 입력으로 렌더하고,
// Answer[] 를 respond() 로 백엔드에 돌려준다. (TUI 의 questionnaire 를 web 으로 미러)

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import type { UiQuestion, UiAnswer } from "./use-session";

type Draft = {
  // 선택된 옵션 인덱스 집합 (단일이면 최대 1개)
  selected: Set<number>;
  // 자유 입력("Type something") 텍스트. 비어있지 않으면 custom 답으로 우선.
  custom: string;
  customActive: boolean;
};

function emptyDraft(): Draft {
  return { selected: new Set(), custom: "", customActive: false };
}

function toAnswer(q: UiQuestion, d: Draft): UiAnswer | null {
  if (d.customActive && d.custom.trim()) {
    return { id: q.id, value: d.custom.trim(), label: d.custom.trim(), wasCustom: true };
  }
  const idxs = [...d.selected].sort((a, b) => a - b);
  if (idxs.length === 0) return null;
  if (q.multiSelect) {
    const opts = idxs.map((i) => q.options[i]).filter(Boolean);
    return {
      id: q.id,
      value: opts.map((o) => o.value).join(","),
      label: opts.map((o) => o.label).join(", "),
      wasCustom: false,
      values: opts.map((o) => o.value),
      labels: opts.map((o) => o.label),
    };
  }
  const o = q.options[idxs[0]];
  return { id: q.id, value: o.value, label: o.label, wasCustom: false, index: idxs[0] };
}

export function QuestionnaireDialog({
  id,
  questions,
  onRespond,
  inline = false,
}: {
  id: string;
  questions: UiQuestion[];
  onRespond: (id: string, value: unknown) => void;
  inline?: boolean;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => emptyDraft()));
  const [tab, setTab] = useState(0);
  const isMulti = questions.length > 1;

  const answers = useMemo(() => questions.map((q, i) => toAnswer(q, drafts[i])), [questions, drafts]);
  const allAnswered = answers.every((a) => a !== null);

  const update = (i: number, fn: (d: Draft) => Draft) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? fn(d) : d)));

  const toggleOption = (qi: number, oi: number) => {
    const q = questions[qi];
    update(qi, (d) => {
      const selected = new Set(d.selected);
      if (q.multiSelect) {
        selected.has(oi) ? selected.delete(oi) : selected.add(oi);
      } else {
        selected.clear();
        selected.add(oi);
      }
      return { ...d, selected, customActive: false };
    });
  };

  const submit = () => {
    if (!allAnswered) return;
    onRespond(id, answers as UiAnswer[]);
  };
  const cancel = () => onRespond(id, null);

  const q = questions[tab];
  const d = drafts[tab];

  const body = (
    <>
      {/* 여러 질문이면 탭 바 */}
      {isMulti ? (
        <div className="flex flex-wrap gap-1 border-b pb-2">
          {questions.map((qq, i) => (
            <button
              key={qq.id}
              onClick={() => setTab(i)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                i === tab ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {answers[i] ? <Check className="size-3 text-emerald-500" /> : null}
              {qq.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
        {isMulti ? <div className="text-sm font-medium">{q.prompt}</div> : null}

        {q.options.map((opt, oi) => {
          const checked = !d.customActive && d.selected.has(oi);
          return (
            <button
              key={opt.value}
              onClick={() => toggleOption(tab, oi)}
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent/50",
                checked ? "border-primary bg-accent" : "border-border",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                  q.multiSelect ? "rounded" : "rounded-full",
                  checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
              >
                {checked ? <Check className="size-3" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block">{opt.label}</span>
                {opt.description ? (
                  <span className="block text-xs text-muted-foreground">{opt.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}

        {/* 자유 입력 */}
        <Input
          placeholder="Or type your own answer…"
          value={d.custom}
          onChange={(e) =>
            update(tab, (dd) => ({ ...dd, custom: e.target.value, customActive: e.target.value.trim().length > 0 }))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && allAnswered) submit();
          }}
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
        {isMulti && tab < questions.length - 1 ? (
          <Button onClick={() => setTab(tab + 1)} disabled={!answers[tab]}>
            Next
          </Button>
        ) : (
          <Button onClick={submit} disabled={!allAnswered}>
            Submit
          </Button>
        )}
      </div>
    </>
  );

  // 인라인(컴포저 자리): TUI 처럼 입력창 대신 질문이 뜨는 형태.
  if (inline) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="text-sm font-medium">
          {isMulti ? `Questions (${tab + 1}/${questions.length})` : q.prompt}
        </div>
        {body}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isMulti ? `Questions (${tab + 1}/${questions.length})` : q.prompt}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
