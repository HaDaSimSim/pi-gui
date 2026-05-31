// 세션 info 패널 (오른쪽). 라이브일 때: 모델/효율 선택, 컨텍스트 사용량,
// raw 통계, 이름 변경. 라이브 아니면 안내.

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SubagentRunCard } from "./subagent-run";
import { GitPanel } from "./git-panel";
import { api, type ModelInfo, type ThinkingLevel } from "./api";
import { useT } from "./i18n";
import type { SessionState, SubagentRunView } from "./use-session";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface InfoPanelProps {
  state: SessionState;
  subagentRuns: SubagentRunView[];
  path: string;
  cwd?: string;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onRename: (name: string) => void;
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString();
}

// 비용을 USD 통화로 (opencode 처럼). 아주 작은 값은 4자리까지.
function fmtCost(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  }).format(n);
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-sm font-medium text-muted-foreground">{children}</div>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

// 토큰 구성 바의 한 세그먼트 (0이면 안 그림).
function seg(color: string, value: number, total: number) {
  if (!value || !total) return null;
  return <div className={color} style={{ width: `${(value / total) * 100}%` }} />;
}

export function InfoPanel({ state, subagentRuns, path, cwd, onSetModel, onSetThinking, onRename }: InfoPanelProps) {
  const { t } = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);

  const controls = state.controls;

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined);
  }, []);
  useEffect(() => {
    setNameDraft(controls?.name ?? "");
  }, [controls?.name]);

  const modelValue = controls?.model ? `${controls.model.provider}/${controls.model.id}` : undefined;
  const thinkingLevels = controls?.availableThinkingLevels.length ? controls.availableThinkingLevels : THINKING_LEVELS;
  const usage = controls?.stats?.contextUsage;
  const percent = usage?.percent ?? null;
  const tk = controls?.stats?.tokens;

  return (
    <Tabs defaultValue="info" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList variant="line" className="shrink-0 gap-1 border-b px-3 pt-2">
        <TabsTrigger value="info">{t("info.title")}</TabsTrigger>
        <TabsTrigger value="subagents">
          {t("info.subagents")}
          {subagentRuns.length ? (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{subagentRuns.length}</span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="git">{t("git.title")}</TabsTrigger>
      </TabsList>

      {/* ── Info 탭 ── */}
      <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto">
        {!state.live || !controls ? (
          <div className="p-4 text-sm text-muted-foreground">{t("info.notLive")}</div>
        ) : (
          <div className="flex flex-col gap-6 p-4">
      {/* 이름 변경 */}
      <div>
        <Label>{t("info.rename")}</Label>
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={t("info.renamePlaceholder")}
              className="h-8"
            />
            <Button
              size="sm"
              onClick={() => {
                onRename(nameDraft.trim());
                setEditingName(false);
              }}
            >
              {t("info.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
              {t("info.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm font-medium">{controls.name || state.name || t("sessions.untitled")}</span>
            <Button size="icon" variant="ghost" className="size-7" aria-label={t("info.rename")} onClick={() => setEditingName(true)}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* 모델 */}
      <div>
        <Label>{t("info.model")}</Label>
        <Select
          value={modelValue}
          onValueChange={(v) => {
            const slash = v.indexOf("/");
            onSetModel(v.slice(0, slash), v.slice(slash + 1));
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("info.changeModel")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {models.map((m) => (
                <SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {/* 효율 (thinking level) */}
      {controls.supportsThinking ? (
        <div>
          <Label>{t("info.efficiency")}</Label>
          <Select
            value={controls.thinkingLevel ?? undefined}
            onValueChange={(v) => onSetThinking(v as ThinkingLevel)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {thinkingLevels.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {/* 컨텍스트 사용량 + 토큰 구성 (opencode 컨텍스트 패널 감성) */}
      <div className="flex flex-col gap-2">
        <Label>{t("info.context")}</Label>
        {usage && percent !== null ? (
          <>
            <Progress value={Math.min(100, Math.round(percent))} />
            <div className="text-sm text-muted-foreground">
              {t("info.contextUsage", {
                used: fmtNum(usage.tokens),
                total: fmtNum(usage.contextWindow),
                percent: Math.round(percent),
              })}
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">{t("info.contextUnknown")}</div>
        )}

        {/* 토큰 구성 바 (input/output/cacheRead/cacheWrite 세그먼트) —
            수치는 아래 통계 그리드와 중복이라 여긴 색상 바만 보여준다. */}
        {tk && tk.total > 0 ? (
          <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {seg("bg-sky-500", tk.input, tk.total)}
            {seg("bg-emerald-500", tk.output, tk.total)}
            {seg("bg-amber-500", tk.cacheRead, tk.total)}
            {seg("bg-violet-500", tk.cacheWrite, tk.total)}
          </div>
        ) : null}
      </div>

      {/* 통계 그리드 (opencode context tab 스펙) */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label={t("info.provider")} value={controls.model?.provider || "—"} />
        <Stat label={t("info.cost")} value={fmtCost(controls.stats?.cost)} />
        <Stat label={t("info.tokens")} value={fmtNum(tk?.total)} />
        <Stat label={t("info.limit")} value={fmtNum(usage?.contextWindow)} />
        <Stat label={t("info.inputTokens")} value={fmtNum(tk?.input)} />
        <Stat label={t("info.outputTokens")} value={fmtNum(tk?.output)} />
        <Stat label={t("info.cacheTokens")} value={`${fmtNum(tk?.cacheRead)} / ${fmtNum(tk?.cacheWrite)}`} />
        <Stat label={t("info.toolCalls")} value={fmtNum(controls.stats?.toolCalls)} />
        <Stat label={t("info.userMessages")} value={fmtNum(controls.stats?.userMessages)} />
        <Stat label={t("info.assistantMessages")} value={fmtNum(controls.stats?.assistantMessages)} />
      </div>

      {/* raw data (접이식) */}
      <Collapsible>
        <CollapsibleTrigger className="text-sm font-medium text-muted-foreground hover:text-foreground">
          {t("info.rawData")}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground/70">
            {JSON.stringify(controls.stats ?? {}, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
          </div>
        )}
      </TabsContent>

      {/* ── Subagents 탭 ── */}
      <TabsContent value="subagents" className="min-h-0 flex-1 overflow-y-auto">
        {subagentRuns.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t("info.noSubagents")}</div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {subagentRuns.map((run, i) => (
              <SubagentRunCard key={run.runId || i} run={run} defaultOpen={subagentRuns.length === 1} />
            ))}
          </div>
        )}
      </TabsContent>

      {/* ── Git 탭 ── */}
      <TabsContent value="git" className="min-h-0 flex-1 overflow-y-auto">
        <GitPanel path={path} cwd={cwd} />
      </TabsContent>
    </Tabs>
  );
}
