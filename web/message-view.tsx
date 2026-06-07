// Chat message rendering — a regular chat UI.
//
// user: right-aligned emphasized bubble (max 60%). assistant: plain text without a bubble + bottom meta (model·time).
// thinking: small gray preview expandable without a header. tool call: compact one-line summary.

import {
  Ban,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  Loader2,
  Search,
  Terminal,
  Wrench,
  X as XIcon,
} from 'lucide-react';
import { createContext, memo, useContext, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useT } from './i18n';
import { Markdown } from './markdown';
import { SubagentRunCard } from './subagent-run';
import type { ChatMessage, ToolCallView } from './use-session';

// Callback context for opening the modal from an inline subagent card.
export const SubagentOpenContext = createContext<((runId: string) => void) | null>(null);

// Extract a human-readable one-line summary from tool call arguments.
function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  if (typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  const prefer = [
    'path',
    'file_path',
    'filePath',
    'command',
    'cmd',
    'pattern',
    'query',
    'url',
    'name',
    'description',
  ];
  for (const k of prefer) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(a)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

function oneLine(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Elapsed time format (same feel as ui-cosmetics): 950ms / 3.2s / 2m 15s
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

// tool name → icon. Known tools get a dedicated icon, otherwise Wrench.
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
  const argStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}, null, 2);
  const summary = oneLine(summarizeArgs(tc.args));
  const running = tc.status === 'running';
  const error = tc.status === 'error';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-0.5">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
          running
            ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
            : error
              ? 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10'
              : 'border-emerald-500/25 bg-emerald-500/5 hover:bg-emerald-500/10',
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded',
            running ? 'text-amber-500' : error ? 'text-destructive' : 'text-muted-foreground',
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
              'flex size-4 shrink-0 items-center justify-center rounded-full',
              error
                ? 'bg-destructive/15 text-destructive'
                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
            )}
          >
            {error ? <XIcon className="size-2.5" /> : <Check className="size-2.5" />}
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-2.5 border-l border-border/60 pl-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            args
          </div>
          <pre className="m-0 overflow-x-auto rounded-md bg-muted/50 p-2.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/80">
            {argStr.slice(0, 2000)}
          </pre>
          {tc.resultText ? (
            <>
              <div className="mt-2.5 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('message.done')}
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
  const isUser = msg.role === 'user';

  // A subagent run is rendered inline within the chat flow (subagents spawned in that session).
  // They're also collected in the info panel Subagents tab, but seeing them right in the conversation context is more natural.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const openSubagent = useContext(SubagentOpenContext);
  if (msg.subagentRun) {
    return (
      <div className="w-full">
        <SubagentRunCard
          run={msg.subagentRun}
          onOpen={openSubagent ? () => openSubagent(msg.subagentRun!.runId) : undefined}
        />
      </div>
    );
  }

  const timeStr = msg.time
    ? new Date(msg.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';

  // thinking: a "Thinking" label in front + a small gray preview expandable. (unlike tool call, distinguished by the label without a border)
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

  // ── user: keep the bubble (right-aligned, max 60%) ──
  if (isUser) {
    return (
      <div className="flex w-full flex-col items-end">
        <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-primary-foreground">
          <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</div>
        </div>
        {timeStr ? (
          <div className="mt-1.5 mr-1 text-xs text-muted-foreground/70">{timeStr}</div>
        ) : null}
      </div>
    );
  }

  // Meta display rule: shown only on the last message of a finished turn (elapsedMs is set).
  // While streaming, just the spinner; intermediate messages (between tool calls) get no meta.
  const showMeta = msg.elapsedMs != null;
  const meta = [
    msg.model ? t('message.assistantModel', { model: msg.model }) : t('message.assistant'),
    msg.elapsedMs != null ? formatElapsed(msg.elapsedMs) : '',
    timeStr,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex w-full flex-col items-start">
      <div className="w-full leading-relaxed">
        {thinkingBlock}
        {msg.text ? (
          <Markdown text={msg.text} />
        ) : !msg.thinking && !msg.toolCalls?.length ? (
          <div className="text-muted-foreground">…</div>
        ) : null}
        {msg.toolCalls?.map((tc) => (
          <ToolCall key={tc.id} tc={tc} />
        ))}
      </div>
      {msg.interrupted ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-500">
          <Ban className="size-3.5" /> {t('message.interrupted')}
        </div>
      ) : null}
      {msg.errorMessage && !msg.interrupted ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
          <Ban className="size-3.5" /> {msg.errorMessage}
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

// Memoization: prevent a completed message from re-parsing markdown due to updates to other
// messages (the main culprit of lag in large sessions). Re-render only when content-related fields change.
function toolSig(tcs?: ToolCallView[]): string {
  if (!tcs?.length) return '';
  return tcs.map((t) => `${t.id}:${t.status}:${t.resultText ? 1 : 0}`).join('|');
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
    x.errorMessage === y.errorMessage &&
    x.model === y.model &&
    x.elapsedMs === y.elapsedMs &&
    x.time === y.time &&
    x.subagentRun === y.subagentRun &&
    toolSig(x.toolCalls) === toolSig(y.toolCalls)
  );
});
