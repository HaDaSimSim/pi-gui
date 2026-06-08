// Todo list rendering, mirroring the pi-skills `todo` extension's TUI widget.
//
// Redesigned for GUI: progress bar at the top showing completion ratio,
// items rendered with visual checkboxes (not ASCII markers).

import { CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDot, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Progress } from '@/components/ui/progress';
import type { TodoItemView, TodoStateView } from './use-session';

const ORDER: Record<TodoItemView['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

// Matches the extension's MAX_WIDGET_ITEMS (8).
const MAX_ITEMS = 8;

export function todoCounts(todo: TodoStateView | null): { done: number; total: number } | null {
  if (!todo || todo.todos.length === 0) return null;
  return {
    done: todo.todos.filter((x) => x.status === 'completed').length,
    total: todo.todos.length,
  };
}

export function todoHasUnfinished(todo: TodoStateView | null): boolean {
  return !!todo && todo.todos.some((x) => x.status !== 'completed');
}

function label(t: TodoItemView): string {
  return t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
}

// `active` = the agent is actually streaming. We only spin the in_progress
// icon while work is happening; at rest it's a static dot so an idle list
// doesn't have a perpetually-spinning indicator.
function StatusIcon({ status, active }: { status: TodoItemView['status']; active: boolean }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />;
    case 'in_progress':
      return active ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-500" />
      ) : (
        <CircleDot className="size-3.5 shrink-0 text-sky-500" />
      );
    default:
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }
}

/** The sorted todo item list (no header). `cap` limits items like the TUI widget.
 * `active` spins the in_progress icon only while the agent is streaming. */
export function TodoItems({
  todo,
  cap,
  active = false,
}: {
  todo: TodoStateView;
  cap?: number;
  active?: boolean;
}) {
  const sorted = [...todo.todos].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const shown = cap ? sorted.slice(0, cap) : sorted;
  const hidden = sorted.length - shown.length;

  return (
    <ul className="flex flex-col gap-0.5">
      {shown.map((item) => (
        <li
          key={`${item.status}-${label(item)}`}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-sm"
        >
          <StatusIcon status={item.status} active={active} />
          <span
            className={
              item.status === 'completed'
                ? 'text-muted-foreground line-through'
                : item.status === 'pending'
                  ? 'text-muted-foreground'
                  : 'text-foreground'
            }
          >
            {label(item)}
          </span>
        </li>
      ))}
      {hidden > 0 ? (
        <li className="pl-6 text-xs text-muted-foreground">…and {hidden} more</li>
      ) : null}
    </ul>
  );
}

/** The aboveEditor widget: collapsible header (progress bar) + capped item list.
 * Shown whenever todos exist (not just while streaming). Defaults to expanded
 * while there's unfinished work, collapsed once everything is done. */
export function TodoWidget({ todo, active = false }: { todo: TodoStateView; active?: boolean }) {
  const c = todoCounts(todo);
  const [open, setOpen] = useState(todoHasUnfinished(todo));
  if (!c) return null;
  const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0;
  return (
    <div className="mb-2 rounded-md border bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Progress value={pct} className="h-1.5 flex-1" />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {c.done}/{c.total}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5">
          <TodoItems todo={todo} cap={MAX_ITEMS} active={active} />
        </div>
      ) : null}
    </div>
  );
}
