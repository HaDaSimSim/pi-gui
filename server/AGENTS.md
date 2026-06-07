# AGENTS.md — server/ (pi-gui backend)

Backend-specific invariants. Repo-wide rules (lock protocol source of truth,
`"pi-web"` owner identity, Tauri spawn, bundling) live in the root
[`AGENTS.md`](../AGENTS.md) — read it too; don't repeat it here.

## Load-bearing invariants (do not break)

- **The lock guard re-checks before every send.** `RuntimeManager.prompt()` (and
  `ensureMine()` for every write control) calls `lock.isMine()` *immediately
  before* writing. On failure it tears down the runtime with `keepLock:true`
  (never touch someone else's lock) and throws `RevokedError` → `409 revoked`.
  Do not move, cache, or skip this check — it's the only thing stopping two
  writers from corrupting a session jsonl (pi puts no OS lock on session files).

- **Browsing must never spawn a runtime.** `/api/directories`, `/api/sessions`,
  `/api/session`, `/api/session/footer`, `/api/git*`, `/api/locks`,
  `/api/fs/list`, `/api/preflight`, `/api/models`, and SSE/WS subscription are
  pure file/registry reads. Only `prompt`/`open` + the control routes (`model`,
  `thinking`, `rename`, `reload`, `abort`, `queue`, `ui-response`,
  `DELETE /api/session/live`) create or touch a runtime + lock. `controls`,
  `footer`, and `commands` *read* an existing runtime if one happens to be live
  but must never create one. `POST /api/session/new` mints a path only;
  `DELETE /api/session` is a file delete that refuses when live/locked. This
  separation is the cost model — keep new read endpoints runtime-free.

- **Bind to `127.0.0.1` only.** The listener is `hostname: '127.0.0.1'`. This
  process has full local shell/file/model-key access through pi's SDK. Never
  change the bind host or add a network listener without adding auth in the same
  change. The Origin/Host guard below is *additional* defense, not a substitute.

- **Keep the Origin + Host guard.** The global middleware rejects non-local
  `Host` headers (DNS-rebinding defense) and cross-origin `Origin`s
  (`tauri://localhost` and `localhost`/`127.0.0.1` only). The `/ws` upgrade is
  not covered by browser CORS, so it must be checked with the same
  `isAllowedOrigin`. Don't loosen `ALLOWED_ORIGIN`/`ALLOWED_HOST`.

- **The UI bridge must stay bound.** `getOrCreate` binds a `WebUIContext` via
  `session.bindExtensions({ uiContext })` so extension
  `ctx.ui.confirm/select/input/notify/...` work; without it `hasUI` is false and
  interactive extensions hang or degrade. `dispose()` must call
  `rt.ui.cancelAll()` (resolves pending requests as cancelled) — drop it and a
  disposed session leaks a forever-pending promise.

- **`gui-state-extension.ts` is observation-only.** It subscribes to
  `session_start`/`tool_execution_end`/`turn_end`/`agent_end` and only *reads*
  entries to broadcast todo/goal snapshots. It must never send a message or
  otherwise steer the agent — that's what makes it safe to run mid-turn. Keep
  new hooks read-only.

## Node strip-only TS constraints

The backend runs under Node native TS stripping (`node server/index.ts`), which
forbids anything needing code emit:

- **No parameter properties** (`constructor(private x: T)`). Use explicit field
  declarations + assignment in the constructor body (see `RuntimeManager`).
- **Explicit `.ts` import extensions** on server-local imports
  (`from './git.ts'`).
- **Don't import `pi-ai`** — it's nested under pi-coding-agent, not a direct
  dependency. Re-declare the small types you need locally (see `ImageContent` in
  `runtime-manager.ts`).
- `vite build` does not type-check; run `pnpm typecheck` separately.

## Other gotchas

- **Don't `import()` the backend to "test boot".** Importing `server/index.ts`
  binds the port as a side effect and collides with a user's dev server. Use the
  `PORT=4318 PI_GUI_NO_PARENT_WATCH=1 nohup node server/index.ts` pattern from
  the root AGENTS.md.
- **`git.ts` stays `execFile` + array args + timeouts.** `cwd`/`hash` are
  client-supplied; never shell-interpolate. `isValidHash` gates commit lookups.
- **`uncaughtException`/`unhandledRejection` are survived on purpose** (one
  session's extension throw must not kill the multi-session server) — except
  `EADDRINUSE`/`EACCES` at startup, which exit immediately so a zombie doesn't
  hold the port.
- Subagent completion isn't emitted as a session event (SDK gap), so an owned
  runtime polls its own session file (`pollSubagents`, 1.5s, broadcast on change
  only). This polls a runtime pi-gui already owns — it is not a foreign-process
  file watcher (that's out of scope).
- Write all code comments in English.
