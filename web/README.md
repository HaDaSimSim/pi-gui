# web/ — the pi-gui frontend

The React single-page app that pi-gui serves. It's a multi-directory,
multi-session chat UI for the **pi** coding agent: browse sessions for free,
open them in tabs, and stream live turns from the sessions you actually talk to.

This is the UI half only. The backend (Hono on `127.0.0.1`, pi's SDK, the
session-lock protocol, the runtime cost model) lives in `server/`. See the repo
root `README.md` for the whole architecture and the cost model, and the root
`AGENTS.md` for the load-bearing backend rules. This doc is frontend-specific
and links up to those.

## Stack

- React 19 + TypeScript, bundled by Vite (Tailwind v4, shadcn/ui on Radix).
- `@/` aliases `web/` (set in both `vite.config.ts` and `tsconfig.json`).
- No data-fetching library — a hand-written `api.ts` client plus a single
  multiplexed WebSocket (`event-bus.ts`).
- Entry: `main.tsx` → `ErrorBoundary` → `PreflightGate` → `App`. The theme/font
  is applied at module load (`import './use-ui-settings'`) before first paint.

## Data flow

```
component  →  api.ts (REST: fetch over /api/*)        →  server
component  →  use-session.ts  ──subscribeEvents()──→  event-bus.ts (1 WebSocket /ws)  →  server
                    │                                         ▲
                    └── reduces events into SessionState ─────┘  (server pushes { path, event })
config.ts: apiUrl() / wsUrl() pick relative vs absolute (browser vs Tauri prod)
```

- **`api.ts`** is the typed REST client. Every call routes its URL through
  `apiUrl()`. It also re-exports `subscribeEvents(path, cb)` which delegates to
  the event bus. `ApiError` carries `status`/`body` so callers can branch on
  `409` (lock conflict → `{ current }`).
- **`event-bus.ts`** holds exactly one WebSocket for the whole app and
  multiplexes per-session events over it. Browsers cap HTTP/1.1 at 6
  connections per origin, so a permanent SSE per tab would starve `fetch` once
  you open enough tabs; a WebSocket doesn't count against that pool. The client
  sends `{ type: "subscribe", paths }`; the server replies with
  `{ path, event }`. It auto-reconnects with backoff and re-sends the live
  subscription set on reconnect. All tabs stay subscribed (even backgrounded
  ones update live).
- **`config.ts`** is the browser-vs-Tauri seam. In the browser (dev and `pnpm
  start`) URLs are relative (`/api`, `/ws`) — the Vite proxy forwards them in
  dev, same-origin in prod. In **Tauri prod** the backend comes up on a dynamic
  port that Rust injects as `window.__PI_GUI_PORT__`; `apiUrl()`/`wsUrl()` then
  build absolute `http://127.0.0.1:<port>` URLs, and `waitForBackendPort()`
  holds the app (in `PreflightGate`) until that port arrives. `reportStreaming()`
  feeds Tauri a busy count for the quit-confirmation prompt.
- **`use-session.ts`** is the heart of a tab. It loads scrollback once (a pure
  file read, no runtime), subscribes to events, and reduces the live event
  stream into a single `SessionState`: streaming deltas (text/thinking/tool
  calls) accumulate into the trailing assistant message, and control events feed
  retry/compaction/queue/todo/goal/error/ui-request state. `entriesToMessages()`
  builds the initial scrollback from session entries.

## Component map

- **`app.tsx`** — shell: sidebar + tab strip + main panel, all resizable. Owns
  open tabs (persisted to `localStorage`), the active tab, the directory/session
  lists, background polling (5s), the settings modal (lazy), and the log viewer
  (Cmd/Ctrl+Shift+L). All tabs stay mounted (hidden when inactive) to keep their
  subscriptions alive.
- **`sidebar.tsx`** — directory list + per-directory session list, search,
  new/rename/delete, draft chips for pending (file-less) sessions.
- **`session-tab.tsx`** — one session: message list (windowed to the last 60
  with lazy "load earlier"), composer, slash-command menu, status line, the
  lock-conflict / error banners, the info panel, and the footer.
- **`message-view.tsx`** — renders one `ChatMessage` (user bubble, assistant
  markdown, collapsible thinking, tool-call summaries, inline subagent cards).
- **`info-panel.tsx`** — the right panel tabs: **info** (model/effort, context
  usage, token-composition bar, stats, rename), **subagents**, **tasks** (goal +
  todo), **git** (`git-panel.tsx`).
- **`footer.tsx`** — the TUI footer mirror.
- **`model-controls.tsx`**, **`titlebar.tsx`** (Tauri drag strip),
  **`settings-modal.tsx`**, **`directory-picker.tsx`** (browser-only server
  folder browse), **`preflight-gate.tsx`**, **`log-viewer.tsx`**.
- Dialogs from the UI bridge: **`ui-request-dialog.tsx`**
  (confirm/select/input/editor + a `btw` branch), **`questionnaire-dialog.tsx`**.
- Subagent viewers: **`subagent-run.tsx`** (card), **`subagent-chat-view.tsx`**
  (full read-only transcript in a modal).
- `components/ui/*` — shadcn primitives. `lib/utils.ts` — `cn()`.

## Mirroring the TUI

pi-gui renders whatever TUI extensions leave behind in the session file plus a
few GUI-state bridge events; extensions never need to know about the web.

- **Footer** (`footer.tsx`) reproduces the ui-cosmetics footer line by line:
  `pwd (branch) • name`, then token/cost/context stats and `model • thinking`,
  plus goal/todo status and an owned/not-owned marker. Data comes from
  `/api/session/footer` (aggregated from the file, no runtime needed).
- **Turn timing** — `turn-meta` custom entries (ui-cosmetics) become per-message
  elapsed time; live turns are timed from `agent_start`.
- **Todo widget** (`todo-widget.tsx`) mirrors the `todo` extension's two
  surfaces: the footer count and the aboveEditor widget (shown only while
  working and items remain), capped at 8 with "…and N more", ASCII markers
  `[ ] [~] [x]`, sorted in_progress → pending → completed.
- **Subagent cards** — `subagent-run` custom entries become inline collapsible
  cards, a Subagents info-panel tab, and a read-only chat modal. Live updates
  arrive via `subagent_runs` events.
- **Slash commands** — `/api/session/commands` (extension commands + skills)
  feed the composer menu; the host builtin `/reload` is always appended.
  Executed by POSTing `/name` through the normal prompt flow.
- **Retry / compaction** — `auto_retry_*` and `compaction_*` events drive the
  composer status line (countdown / spinner), mirroring the TUI loaders.

## i18n

`i18n.ts` is a flat dictionary with a tiny `useT()` hook and `{name}`
interpolation (no external lib). **`en` is the source of truth; `ko` must mirror
its key set exactly.** After editing the dictionary, verify parity with
`pnpm test:unit` (the i18n test parses both blocks and compares key sets). The
active language lives in `use-ui-settings.ts` (localStorage), which also owns
theme (light / dark / true-dark), density, motion, and fonts — applied to the
`<html>` element.

## Verify

```bash
pnpm typecheck   # tsc --noEmit — vite build does NOT type-check
pnpm build:web   # vite build (code-splits react/markdown/settings)
pnpm test:unit   # includes i18n en/ko parity
```
