// Session footer — mirrors the TUI ui-cosmetics footer.
//
// One line: pwd (branch) • name   ···   ↑in ↓out Rcache Wcache $cost  ctx  ·  model • thinking
// Data from /api/session/footer (aggregates tokens/cost from the file even without a runtime).
// Re-fetched when refreshKey changes (turn end etc.).

import { useEffect, useState } from 'react';
import { api, type FooterData } from './api';
import type { GoalStateView, TodoStateView } from './use-session';

const GOAL_EMOJI: Record<GoalStateView['status'], string> = {
  pursuing: '🎯',
  paused: '⏸',
  achieved: '✅',
  blocked: '🚧',
  'budget-limited': '⛔',
};

function fmtTokens(n: number): string {
  // Exactly the same as ui-cosmetics formatTokens
  if (n < 1000) return `${n}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function homeShort(p: string): string {
  // The browser doesn't know HOME — turn /Users/<x> or /home/<x> into ~.
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
}

export function Footer({
  path,
  cwd,
  refreshKey,
  goal,
  todo,
}: {
  path: string;
  cwd?: string;
  refreshKey?: number;
  goal?: GoalStateView | null;
  todo?: TodoStateView | null;
}) {
  const [data, setData] = useState<FooterData | null>(null);

  useEffect(() => {
    let closed = false;
    // When refreshKey changes (turn end etc.), this effect re-runs and refreshes the footer.
    void refreshKey;
    api
      .footer(path, cwd)
      .then((d) => !closed && setData(d))
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [path, cwd, refreshKey]);

  if (!data) return null;

  // Left: pwd (branch) • name  (TUI line 1)
  let pwd = '';
  if (data.cwd) {
    pwd = homeShort(data.cwd);
    if (data.branch) pwd += ` (${data.branch})`;
    if (data.name) pwd += ` • ${data.name}`;
  } else if (data.name) {
    pwd = data.name;
  }

  // stats (left of TUI line 2): ↑in ↓out Rcache Wcache $cost  ctx/window
  const stats: string[] = [];
  const tk = data.tokens;
  if (tk.input) stats.push(`↑${fmtTokens(tk.input)}`);
  if (tk.output) stats.push(`↓${fmtTokens(tk.output)}`);
  if (tk.cacheRead) stats.push(`R${fmtTokens(tk.cacheRead)}`);
  if (tk.cacheWrite) stats.push(`W${fmtTokens(tk.cacheWrite)}`);
  if (data.cost) stats.push(`$${data.cost.toFixed(3)}`);
  if (data.contextUsage) {
    const u = data.contextUsage;
    stats.push(
      u.tokens === null
        ? `?/${fmtTokens(u.contextWindow)}`
        : `${fmtTokens(u.tokens)}/${fmtTokens(u.contextWindow)}`,
    );
  }
  const statsLine = stats.join(' ');

  // model • thinking (right of TUI line 2)
  let model = data.model?.id || '';
  if (model && data.supportsThinking) {
    model +=
      data.thinkingLevel && data.thinkingLevel !== 'off'
        ? ` • ${data.thinkingLevel}`
        : ' • thinking off';
  }

  if (!pwd && !statsLine && !model) return null;

  // goal/todo status (mirrors the extensions' footer status).
  const goalText = goal
    ? `${GOAL_EMOJI[goal.status]} goal ${goal.status}${goal.status === 'pursuing' ? ` #${goal.iteration}` : ''}`
    : '';
  const todoText = todo?.todos.length
    ? `${todo.todos.filter((x) => x.status === 'completed').length}/${todo.todos.length} todos`
    : '';
  const stateLine = [goalText, todoText].filter(Boolean).join('   ');

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t bg-background px-6 py-1.5 font-mono text-[11px] text-muted-foreground/70">
      {/* Line 1: pwd (branch) • name */}
      {pwd ? <div className="truncate">{pwd}</div> : null}
      {/* goal / todo status */}
      {stateLine ? <div className="truncate">{stateLine}</div> : null}
      {/* Line 2: stats ··· model • thinking (justified to both ends, wraps when narrow) */}
      {statsLine || model ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="break-all">{statsLine}</span>
          {model ? <span className="text-muted-foreground">{model}</span> : null}
        </div>
      ) : null}
      {/* Line 3: runtime ownership */}
      <div>{data.live ? 'owned' : 'not-owned'}</div>
    </div>
  );
}
