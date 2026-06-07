// Displays a subagent run expanded into a chat UI, "like the main thread".
// Read-only — can't send/abort messages (the main controls that subagent).

import { ArrowLeft, Loader2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useT } from './i18n';
import { Markdown } from './markdown';
import type { SubagentRunView, SubagentTranscriptItem } from './use-session';

function statusDot(status: SubagentRunView['status']): string {
  return status === 'running'
    ? 'bg-amber-500'
    : status === 'failed'
      ? 'bg-destructive'
      : 'bg-emerald-500';
}

// Render a single transcript entry like a main-thread message.
function TranscriptItemView({ item }: { item: SubagentTranscriptItem }) {
  if (item.kind === 'thinking') {
    return (
      <details className="piweb-thinking mb-1.5">
        <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <span className="shrink-0 font-medium italic">Thinking</span>
          <span className="truncate">{item.text.replace(/\s+/g, ' ').slice(0, 80)}</span>
        </summary>
        <pre className="m-0 mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground/60">
          {item.text}
        </pre>
      </details>
    );
  }
  if (item.kind === 'toolCall' || item.kind === 'toolResult') {
    return (
      <div className="my-1 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Wrench className="size-3.5 shrink-0" />
          <span className="font-medium">
            {item.toolName || (item.kind === 'toolCall' ? 'tool' : 'result')}
          </span>
        </div>
        {item.text ? (
          <pre className="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground/80">
            {item.text}
          </pre>
        ) : null}
      </div>
    );
  }
  // text
  return item.text ? <Markdown text={item.text} /> : null;
}

export function SubagentChatView({ run, onBack }: { run: SubagentRunView; onBack: () => void }) {
  const { t } = useT();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: back + title + meta */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('common.back')}
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className={cn('size-2 shrink-0 rounded-full', statusDot(run.status))} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {run.agent}
        </span>
      </div>

      {/* meta line */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
        {run.model ? <span className="font-mono">{run.model}</span> : null}
        {run.turns.length > 1 ? <span>{run.turns.length} turns</span> : null}
        {run.cost != null ? <span>${run.cost.toFixed(4)}</span> : null}
        <span className="inline-flex items-center gap-1">
          {run.status === 'running' ? <Loader2 className="size-3 animate-spin" /> : null}
          {t(`subagent.status.${run.status}`)}
        </span>
      </div>

      {/* read-only notice */}
      <div className="shrink-0 bg-muted/40 px-4 py-1 text-center text-[11px] text-muted-foreground/70">
        {t('subagent.readOnly')}
      </div>

      {/* conversation body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {run.turns.map((turn) => (
            <div key={`${turn.prompt}::${turn.finalOutput}`} className="flex flex-col gap-4">
              {/* prompt = user bubble */}
              {turn.prompt ? (
                <div className="flex w-full flex-col items-end">
                  <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-primary-foreground">
                    <div className="whitespace-pre-wrap break-words leading-relaxed">
                      {turn.prompt}
                    </div>
                  </div>
                </div>
              ) : null}
              {/* response = assistant (transcript if present, else finalOutput) */}
              <div className="flex w-full flex-col items-start">
                <div className="w-full leading-relaxed">
                  {turn.transcript && turn.transcript.length > 0 ? (
                    turn.transcript.map((it) => (
                      <TranscriptItemView
                        key={`${it.kind}-${it.toolName ?? ''}-${it.text}`}
                        item={it}
                      />
                    ))
                  ) : turn.finalOutput ? (
                    <Markdown text={turn.finalOutput} />
                  ) : (
                    <div className="text-muted-foreground">…</div>
                  )}
                </div>
                {turn.error ? (
                  <div className="mt-2 text-xs text-destructive">{turn.error}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
