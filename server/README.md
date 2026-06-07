# server/ — pi-gui backend

The Node backend for pi-gui. It's a thin host on top of pi's SDK
(`@earendil-works/pi-coding-agent`): a [Hono](https://hono.dev) HTTP/WS server
that browses pi sessions as plain file reads and spins up a live pi runtime only
when you actually send a prompt.

Runs under Node native TS stripping (`node server/index.ts`) — no build step in
dev. See the root [`README.md`](../README.md) for the product overview and the
root [`AGENTS.md`](../AGENTS.md) for repo-wide rules; this doc is backend-only.

## Files

| File | Role |
|---|---|
| `index.ts` | Hono routes, CORS/Origin/Host guard, SSE + WS multiplexing, prod static serve, log ring buffer, parent-death watchdog, shutdown. |
| `runtime-manager.ts` | `sessionPath → live AgentSession`. The lock guard, `getOrCreate`/`prompt`/`dispose`, subscription channels, idle reaper, subagent polling, UI-bridge binding. |
| `web-ui-context.ts` | `WebUIContext`: the `ExtensionUIContext` bridge — `confirm/select/input/editor/notify/questionnaire/showBtw` over WS/SSE; terminal-only methods are no-ops. |
| `gui-state-extension.ts` | GUI-only in-process extension. Observes lifecycle hooks and broadcasts `todo-list`/`goal-state` snapshots to the browser. Observation-only. |
| `preflight.ts` | Read-only checks: pi installed, models/auth present, session-lock extension present. |
| `git.ts` | Read-only git queries (status, branches, commit graph, commit detail). `execFile` with array args + timeouts only. |

## Cost model (why it scales)

Browsing is free; only live chat costs a runtime.

- **No runtime, no lock:** listing directories/sessions, reading scrollback,
  footer token/cost, git status, preflight, models, SSE/WS subscription,
  minting a new session path, deleting a session file.
- **Runtime + exclusive lock:** sending a prompt, opening a session live,
  changing model/thinking, rename, reload, abort, queue edit.

Idle runtimes are reaped after 5 minutes (`IDLE_TIMEOUT_MS`). You can fan out a
huge sidebar of directories/sessions for free; only the sessions you talk to
spin up a runtime.

## Route map

### Browse-only — pure file reads, never touch a runtime or lock

| Method · Path | Purpose |
|---|---|
| `GET /api/directories` | All sessions (`SessionManager.listAll()`) grouped by cwd. |
| `GET /api/sessions?cwd=` | Sessions in one directory (+ a `live` flag per session). |
| `GET /api/session?path=` | One session's scrollback (entries/tree). Empty + `pending:true` if no file yet. |
| `GET /api/session/footer?path=` | TUI-style footer: summed assistant token usage + cost, git branch; merges live model/thinking/context if a runtime exists. |
| `GET /api/session/controls?path=` | Controls/stats snapshot. `live:false` + resolved default model when no runtime. |
| `GET /api/session/commands?path=` | Slash commands — only populated when a runtime is live. |
| `GET /api/git?cwd=` | Branch, ahead/behind, changed files, branches, commit graph. |
| `GET /api/git/commit?cwd=&hash=` | Single-commit detail (message + per-file numstat). |
| `GET /api/fs/list?path=` | Subdirectories of a path (folder picker for the browser build). |
| `GET /api/locks` | Every current lock holder, including the TUI/CLI. |
| `GET /api/live` | Currently live runtimes in this process. |
| `GET /api/models` | Available models from the registry. |
| `GET /api/preflight` | pi/models/session-lock readiness. |
| `GET /api/log` | Last-500-line backend log ring buffer (debug UI). |
| `POST /api/session/new` | Mint a new session **path** under a cwd. No runtime/lock; the file is written on the first prompt. |
| `DELETE /api/session?path=` | Delete the jsonl file. Refuses (409) if the session is live or locked elsewhere. |

### Runtime / lock-touching — create or touch a runtime + grab the lock

| Method · Path | Purpose |
|---|---|
| `POST /api/session/open` | Go live: acquire the lock. `force:true` takes it over. `409 locked` with the current holder otherwise. |
| `POST /api/session/prompt` | Send a prompt (spins up the runtime if absent). Re-checks `isMine()` right before sending; `409 revoked` if the lock was taken. `steer`/`followUp` while streaming. |
| `POST /api/session/abort` | Abort an in-flight response (lock required, no-op safe). |
| `POST /api/session/model` | Change model. `409 locked`/`revoked` on lock conflict. |
| `POST /api/session/thinking` | Change thinking level (efficiency). |
| `POST /api/session/rename` | Rename the session (writes the file). |
| `POST /api/session/reload` | Reload extensions/skills. `409 streaming` if a turn is in progress. |
| `POST /api/session/queue` | Replace the steering/followUp queue (lock required). |
| `POST /api/session/ui-response` | Deliver the browser's answer to a pending `ctx.ui.*` request. |
| `DELETE /api/session/live?path=` | Tear down a live runtime (releases the lock). |

### Streaming

- `GET /api/session/events?path=` — SSE. Subscribes to one session channel.
  View/receive only; **no lock or runtime required** (you can spectate a session
  someone else is driving). Emits a `_connected` snapshot, then forwarded
  runtime events, with a 15s keepalive ping.
- `GET /ws` — WebSocket. One socket per browser, multiplexing many sessions
  (dodges the per-origin HTTP/1.1 6-connection cap). Client sends
  `{type:"subscribe",paths}`; server pushes `{path,event}` so the frontend
  routes by path.

## How live chat works

1. `POST /api/session/prompt` calls `RuntimeManager.getOrCreate(path)`, which
   opens (or mints) the `SessionManager`, grabs the `SessionLock`, builds a
   `DefaultResourceLoader` with the GUI-state extension injected, and creates the
   `AgentSession`.
2. The runtime's event stream is broadcast onto the session's subscription
   channel; every SSE/WS subscriber on that path receives it.
3. `RuntimeManager.prompt()` re-verifies `lock.isMine()` **before every send**.
   If the lock was taken over, it tears down the runtime and returns
   `RevokedError` (`409 revoked`).
4. `session.bindExtensions({ uiContext })` wires a `WebUIContext` so extension
   `ctx.ui.confirm/select/input/notify/...` calls cross to the browser as
   `ui_request`/`ui_notify` events and resolve via `POST /api/session/ui-response`.

## Lock model (summary)

Exclusive, no auto-expiry. `lock.state()` is `free`/`mine`/`lost` (`lost` = you
held it but the on-disk token changed or vanished). pi-gui re-checks ownership
before every write. The protocol lives in `shared/session-lock.ts` (a symlink
into the pi-skills submodule) so pi-gui and the pi TUI see each other's claims.
Owner identifier on disk is `"pi-web"`. See the root docs for the full rationale.

## Run standalone

```bash
node server/index.ts          # binds 127.0.0.1:4317
PORT=4318 node server/index.ts  # custom port
PORT=0 node server/index.ts     # OS-picked port (Tauri prod); prints PI_GUI_PORT=<n>
```

- Binds `127.0.0.1` only — full local shell/file/model-key access via pi's SDK.
  Never expose to a network without adding auth first.
- Serves `dist-web/` (static + SPA fallback) **only when that dir exists**
  (production). In dev, Vite serves the frontend and proxies `/api/`.
- Sets `process.env.PI_WEB_HOST = '1'` at startup so the pi-skills session-lock
  extension stands down (pi-gui manages the lock directly) and web-aware
  extensions (questionnaire/btw) route through the UI bridge.
- Env: `PORT` (default 4317), `PI_GUI_PARENT_PID` / `PI_GUI_NO_PARENT_WATCH`
  (parent-death watchdog), `PI_AGENT_DIR` (override `~/.pi/agent`).
