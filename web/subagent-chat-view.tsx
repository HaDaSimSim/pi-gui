// Displays a subagent run expanded into a chat UI, "like the main thread".
// Read-only — can't send/abort messages (the main controls that subagent).
// Reuses the main-thread MessageView by converting the run's turns/transcript
// into the same ChatMessage[] shape, so rendering, width, and spacing match.

import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useT } from './i18n';
import { MessageView } from './message-view';
import type { ChatMessage, SubagentRunView, ToolCallView } from './use-session';

function statusDot(status: SubagentRunView['status']): string {
  return status === 'running'
    ? 'bg-amber-500'
    : status === 'failed'
      ? 'bg-destructive'
      : 'bg-emerald-500';
}

// Convert a subagent run into main-thread ChatMessage[]. Each turn's prompt becomes a
// user message; the transcript is grouped into assistant messages (text flushes a new
// message so text/tool/text ordering is preserved, mirroring the main thread). When no
// transcript exists, finalOutput is the assistant text. Errors become a trailing message.
function runToMessages(run: SubagentRunView): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let toolSeq = 0;
  run.turns.forEach((turn, idx) => {
    if (turn.prompt) {
      msgs.push({ key: `sa-${run.runId}-u${idx}`, role: 'user', text: turn.prompt });
    }
    const transcript = turn.transcript ?? [];
    if (transcript.length > 0) {
      // `cur` is the assistant message currently being assembled. Using a single-element
      // holder array avoids the closure in flush() narrowing `cur` to `null` for TS.
      const ref: { cur: ChatMessage | null } = { cur: null };
      let lastTool: NonNullable<ChatMessage['toolCalls']>[number] | null = null;
      const flush = () => {
        if (ref.cur) msgs.push(ref.cur);
        ref.cur = null;
        lastTool = null;
      };
      const ensure = (): ChatMessage => {
        if (!ref.cur) {
          ref.cur = {
            key: `sa-${run.runId}-a${idx}-${msgs.length}`,
            role: 'assistant',
            text: '',
            model: run.model,
          };
        }
        return ref.cur;
      };
      for (const it of transcript) {
        if (it.kind === 'thinking') {
          const m = ensure();
          m.thinking = m.thinking ? `${m.thinking}\n\n${it.text}` : it.text;
        } else if (it.kind === 'text') {
          // A new text block after existing content starts a fresh assistant message.
          if (ref.cur && (ref.cur.text || ref.cur.toolCalls?.length)) flush();
          const m = ensure();
          m.text = m.text ? `${m.text}\n\n${it.text}` : it.text;
        } else if (it.kind === 'toolCall') {
          const m = ensure();
          m.toolCalls = m.toolCalls ?? [];
          lastTool = {
            id: `sa-${run.runId}-t${toolSeq++}`,
            name: it.toolName || 'tool',
            // Prefer the full structured args (newer sessions); fall back to the
            // compact summary text for older sessions that lack `args`.
            args: it.args ?? it.text,
            status: 'done',
          };
          m.toolCalls.push(lastTool);
        } else if (it.kind === 'toolResult') {
          // Prefer untruncated fullText; fall back to the compact text.
          const resultText = it.fullText ?? it.text;
          const status: ToolCallView['status'] = it.isError ? 'error' : 'done';
          if (lastTool) {
            lastTool.resultText = resultText;
            lastTool.status = status;
          } else {
            const m = ensure();
            m.toolCalls = m.toolCalls ?? [];
            m.toolCalls.push({
              id: `sa-${run.runId}-t${toolSeq++}`,
              name: it.toolName || 'result',
              args: '',
              status,
              resultText,
            });
          }
        }
      }
      flush();
    } else if (turn.finalOutput) {
      msgs.push({
        key: `sa-${run.runId}-a${idx}`,
        role: 'assistant',
        text: turn.finalOutput,
        model: run.model,
      });
    }
    if (turn.error) {
      msgs.push({
        key: `sa-${run.runId}-e${idx}`,
        role: 'assistant',
        text: '',
        errorMessage: turn.error,
      });
    }
  });
  return msgs;
}

export function SubagentChatView({ run, onBack }: { run: SubagentRunView; onBack: () => void }) {
  const { t } = useT();
  const messages = runToMessages(run);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: back + title + meta. pr-10 reserves space for the Dialog's absolute close (X) button. */}
      <div className="flex shrink-0 items-center gap-2 border-b py-2 pl-3 pr-10">
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

      {/* conversation body — same MessageView + spacing as the main thread */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col px-4 py-6">
          {messages.length === 0 ? (
            <div className="text-muted-foreground">…</div>
          ) : (
            messages.map((m, i) => (
              <div key={m.key} className={i === 0 ? undefined : 'mt-9'}>
                <MessageView msg={m} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
