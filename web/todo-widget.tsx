// Todo list rendering, mirroring the pi-skills `todo` extension's TUI widget.
//
// The extension shows two surfaces (todo/index.ts):
//   - footer status: "n/N todos", always shown when todos exist (idle or working)
//   - aboveEditor widget: shown only while working AND there are unfinished items;
//     header "n/N todos" + items sorted in_progress -> pending -> completed,
//     ASCII markers [ ] [~] [x], capped, with "…and N more".
// pi-gui mirrors both: this file renders the item list; the composer shows it
// above the editor while streaming, and the footer shows the count.

import type { TodoItemView, TodoStateView } from './use-session';

const ORDER: Record<TodoItemView['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};
const MARK: Record<TodoItemView['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};
const MARK_COLOR: Record<TodoItemView['status'], string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-sky-500',
  completed: 'text-emerald-500',
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

/** The sorted todo item list (no header). `cap` limits items like the TUI widget. */
export function TodoItems({ todo, cap }: { todo: TodoStateView; cap?: number }) {
  const sorted = [...todo.todos].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const shown = cap ? sorted.slice(0, cap) : sorted;
  const hidden = sorted.length - shown.length;

  return (
    <ul className="flex flex-col gap-1">
      {shown.map((item) => (
        <li
          key={`${item.status}-${label(item)}`}
          className="flex items-start gap-2 font-mono text-sm"
        >
          <span className={MARK_COLOR[item.status]}>{MARK[item.status]}</span>
          <span
            className={
              item.status === 'completed'
                ? 'text-muted-foreground line-through'
                : item.status === 'pending'
                  ? 'text-muted-foreground'
                  : ''
            }
          >
            {label(item)}
          </span>
        </li>
      ))}
      {hidden > 0 ? (
        <li className="pl-7 text-sm text-muted-foreground">…and {hidden} more</li>
      ) : null}
    </ul>
  );
}

/** The aboveEditor widget: header "n/N todos" + capped item list. */
export function TodoWidget({ todo }: { todo: TodoStateView }) {
  const c = todoCounts(todo);
  if (!c) return null;
  return (
    <div className="mb-2 rounded-md border bg-muted/30 px-3 py-2">
      <div className="mb-1 text-xs text-muted-foreground">
        {c.done}/{c.total} todos
      </div>
      <TodoItems todo={todo} cap={MAX_ITEMS} />
    </div>
  );
}
