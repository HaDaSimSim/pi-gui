// GUI-only in-process extension, injected by RuntimeManager when pi-gui owns a
// runtime. It bridges session state that extensions persist via `appendEntry`
// (which emits no session event) to the web host, WITHOUT polling.
//
// How: file-based extensions (todo, goal, subagents) write custom entries with
// appendEntry — durable but event-less. This extension observes the agent
// lifecycle (tool_execution_end / turn_end / agent_end), reads the latest
// snapshot of each known customType from the session entries, and pushes a
// broadcast to the browser when it changes. Observation-only hooks never steer
// the agent, so this is safe mid-turn (e.g. right after todo_write runs).
//
// pi core and the pi-skills extensions are untouched; this only runs in the GUI.

// Minimal local shapes (the SDK's ExtensionAPI types aren't imported here to
// keep this file dependency-light; see runtime-manager for the factory wiring).
interface TodoItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoState {
  todos: TodoItem[];
}

export interface GoalState {
  objective: string;
  status: 'pursuing' | 'paused' | 'achieved' | 'blocked' | 'budget-limited';
  iteration: number;
  tokenBudget?: number;
  note?: string;
  createdAt: number;
}

type Entry = { type?: string; customType?: string; data?: unknown };

// Extract the latest (last-wins) snapshot of a customType from session entries.
function latest(entries: Entry[], customType: string): unknown {
  let found: unknown;
  for (const e of entries) {
    if (e.type === 'custom' && e.customType === customType) found = e.data;
  }
  return found;
}

function todoFrom(entries: Entry[]): TodoState | null {
  const d = latest(entries, 'todo-list') as { todos?: TodoItem[] } | undefined;
  if (!d || !Array.isArray(d.todos)) return null;
  return { todos: d.todos };
}

function goalFrom(entries: Entry[]): GoalState | null {
  const d = latest(entries, 'goal-state') as (GoalState & { cleared?: boolean }) | undefined;
  if (!d || d.cleared || typeof d.objective !== 'string') return null;
  return d;
}

// Cheap change signatures so we only broadcast on actual change.
function todoSig(t: TodoState | null): string {
  if (!t) return '';
  return t.todos.map((x) => `${x.status}:${x.activeForm ?? x.content}`).join('|');
}
function goalSig(g: GoalState | null): string {
  if (!g) return '';
  return `${g.status}:${g.iteration}:${g.objective}:${g.note ?? ''}`;
}

export interface GuiStateBroadcaster {
  todo: (state: TodoState | null) => void;
  goal: (state: GoalState | null) => void;
}

/**
 * Build the GUI-state extension factory. `emit` is wired to the session's
 * broadcast channel by RuntimeManager. The returned function is an
 * ExtensionFactory `(pi) => void` the SDK calls with the extension API.
 */
export function makeGuiStateExtension(emit: GuiStateBroadcaster) {
  return (pi: {
    sessionManager?: { getEntries?: () => unknown[] };
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  }): void => {
    let lastTodo = '';
    let lastGoal = '';

    const sync = () => {
      const entries = (pi.sessionManager?.getEntries?.() ?? []) as Entry[];
      const todo = todoFrom(entries);
      const ts = todoSig(todo);
      if (ts !== lastTodo) {
        lastTodo = ts;
        emit.todo(todo);
      }
      const goal = goalFrom(entries);
      const gs = goalSig(goal);
      if (gs !== lastGoal) {
        lastGoal = gs;
        emit.goal(goal);
      }
    };

    // Observe lifecycle points where todo/goal may have changed. These handlers
    // only read state; they never send messages, so they can't steer a turn.
    pi.on('session_start', sync);
    pi.on('tool_execution_end', sync);
    pi.on('turn_end', sync);
    pi.on('agent_end', sync);
  };
}
