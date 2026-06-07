// Session info panel (right side). When live: model/effort selection, context usage,
// raw stats, rename. When not live, shows guidance.

import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ThinkingLevel } from './api';
import { GitPanel } from './git-panel';
import { useT } from './i18n';
import { ModelControls } from './model-controls';
import { SubagentRunCard } from './subagent-run';
import type { SessionState, SubagentRunView } from './use-session';

interface InfoPanelProps {
  state: SessionState;
  subagentRuns: SubagentRunView[];
  path: string;
  cwd?: string;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onRename: (name: string) => void;
  onOpenSubagent?: (run: SubagentRunView) => void;
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

// Cost as USD currency (like opencode). Very small values go to 4 decimals.
function fmtCost(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
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

// One segment of the token-composition bar (not drawn if 0).
function seg(color: string, value: number, total: number) {
  if (!value || !total) return null;
  return <div className={color} style={{ width: `${(value / total) * 100}%` }} />;
}

export function InfoPanel({
  state,
  subagentRuns,
  path,
  cwd,
  onSetModel,
  onSetThinking,
  onRename,
  onOpenSubagent,
}: InfoPanelProps) {
  const { t } = useT();
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);

  const controls = state.controls;

  useEffect(() => {
    setNameDraft(controls?.name ?? '');
  }, [controls?.name]);

  const usage = controls?.stats?.contextUsage;
  const percent = usage?.percent ?? null;
  const tk = controls?.stats?.tokens;

  return (
    <Tabs defaultValue="info" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList variant="line" className="h-auto shrink-0 gap-4 border-b px-4 pt-2">
        <TabsTrigger
          value="info"
          className="flex-none rounded-none border-0 bg-transparent px-0 pb-2 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-0 dark:data-[state=active]:bg-transparent"
        >
          {t('info.title')}
        </TabsTrigger>
        <TabsTrigger
          value="subagents"
          className="flex-none rounded-none border-0 bg-transparent px-0 pb-2 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-0 dark:data-[state=active]:bg-transparent"
        >
          {t('info.subagents')}
          {subagentRuns.length ? (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              {subagentRuns.length}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger
          value="git"
          className="flex-none rounded-none border-0 bg-transparent px-0 pb-2 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-0 dark:data-[state=active]:bg-transparent"
        >
          {t('git.title')}
        </TabsTrigger>
      </TabsList>

      {/* ── Info tab ── */}
      <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto">
        {!state.live || !controls ? (
          <div className="p-4 text-sm text-muted-foreground">{t('info.notLive')}</div>
        ) : (
          <div className="flex flex-col gap-6 p-4">
            {/* Rename */}
            <div>
              <Label>{t('info.rename')}</Label>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder={t('info.renamePlaceholder')}
                    className="h-8"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      onRename(nameDraft.trim());
                      setEditingName(false);
                    }}
                  >
                    {t('info.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
                    {t('info.cancel')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-sm font-medium">
                    {controls.name || state.name || t('sessions.untitled')}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={t('info.rename')}
                    onClick={() => setEditingName(true)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>

            {/* Model / effort — reuses the same ModelControls as the composer (combobox + borderless effort) */}
            <div>
              <Label>{t('info.model')}</Label>
              <div className="-ml-2">
                <ModelControls
                  model={
                    controls.model
                      ? { provider: controls.model.provider, id: controls.model.id }
                      : null
                  }
                  thinking={controls.thinkingLevel ?? null}
                  onSetModel={onSetModel}
                  onSetThinking={onSetThinking}
                />
              </div>
            </div>

            {/* Context usage + token composition (opencode context-panel feel) */}
            <div className="flex flex-col gap-2">
              <Label>{t('info.context')}</Label>
              {usage && percent !== null ? (
                <>
                  <Progress value={Math.min(100, Math.round(percent))} />
                  <div className="text-sm text-muted-foreground">
                    {t('info.contextUsage', {
                      used: fmtNum(usage.tokens),
                      total: fmtNum(usage.contextWindow),
                      percent: Math.round(percent),
                    })}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">{t('info.contextUnknown')}</div>
              )}

              {/* Token composition bar (input/output/cacheRead/cacheWrite segments) —
            the numbers duplicate the stats grid below, so here we only show the color bar. */}
              {tk && tk.total > 0 ? (
                <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  {seg('bg-sky-500', tk.input, tk.total)}
                  {seg('bg-emerald-500', tk.output, tk.total)}
                  {seg('bg-amber-500', tk.cacheRead, tk.total)}
                  {seg('bg-violet-500', tk.cacheWrite, tk.total)}
                </div>
              ) : null}
            </div>

            {/* Stats grid (opencode context tab spec) */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Stat label={t('info.provider')} value={controls.model?.provider || '—'} />
              <Stat label={t('info.cost')} value={fmtCost(controls.stats?.cost)} />
              <Stat label={t('info.tokens')} value={fmtNum(tk?.total)} />
              <Stat label={t('info.limit')} value={fmtNum(usage?.contextWindow)} />
              <Stat label={t('info.inputTokens')} value={fmtNum(tk?.input)} />
              <Stat label={t('info.outputTokens')} value={fmtNum(tk?.output)} />
              <Stat
                label={t('info.cacheTokens')}
                value={`${fmtNum(tk?.cacheRead)} / ${fmtNum(tk?.cacheWrite)}`}
              />
              <Stat label={t('info.toolCalls')} value={fmtNum(controls.stats?.toolCalls)} />
              <Stat label={t('info.userMessages')} value={fmtNum(controls.stats?.userMessages)} />
              <Stat
                label={t('info.assistantMessages')}
                value={fmtNum(controls.stats?.assistantMessages)}
              />
            </div>

            {/* raw data (collapsible) */}
            <Collapsible>
              <CollapsibleTrigger className="text-sm font-medium text-muted-foreground hover:text-foreground">
                {t('info.rawData')}
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

      {/* ── Subagents tab ── */}
      <TabsContent value="subagents" className="min-h-0 flex-1 overflow-y-auto p-0.5">
        {subagentRuns.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t('info.noSubagents')}</div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {subagentRuns.map((run, i) => (
              <SubagentRunCard
                key={run.runId || i}
                run={run}
                defaultOpen={subagentRuns.length === 1}
                onOpen={onOpenSubagent ? () => onOpenSubagent(run) : undefined}
              />
            ))}
          </div>
        )}
      </TabsContent>

      {/* ── Git tab ── */}
      <TabsContent value="git" className="min-h-0 flex-1 overflow-y-auto">
        <GitPanel path={path} cwd={cwd} />
      </TabsContent>
    </Tabs>
  );
}
