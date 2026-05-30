# AGENTS.md

Agent guide for working in the **pi-web** codebase. Read `README.md` first for
the what/why; this file is the how-to-work-here.

## What this is

A host layer over pi's SDK that serves a multi-session web UI. Two halves:
`server/` (Hono backend, Node) and `web/` (React + Cloudscape frontend). The
lock protocol is **not** owned here — it lives in pi-skills and is symlinked in.

## Hard rules

- **Backend binds to `127.0.0.1` only.** Never change the bind host to `0.0.0.0`
  or add a network listener without adding authentication in the same change.
  This process has full local shell/file/model-key access via pi's SDK.
- **The lock guard is load-bearing.** `RuntimeManager.prompt()` re-checks
  `lock.isMine()` *before every send*. Do not move, cache, or skip that check —
  it's the only thing preventing two writers from corrupting a session jsonl
  (pi puts no OS lock on session files).
- **Browsing must never spawn a runtime.** `/api/directories`, `/api/sessions`,
  `/api/session`, and SSE subscription are pure reads. Only `prompt`/`open`
  create a runtime + lock. Keep that separation; it's the cost model the whole
  design rests on.
- **`shared/session-lock.ts` is a symlink, not a copy.** The source of truth is
  `pi-skills/extensions/session-lock/shared/session-lock.ts`. Edit the protocol
  *there*, not here — both the pi TUI extension and pi-web must stay byte-identical.

## Runtime / TypeScript execution

- The backend runs under Node's native TS stripping: `node server/index.ts`.
  **Node strip-only mode does not support TypeScript "parameter properties"**
  (`constructor(private x: T)`) or other syntax that needs code emit. Use
  explicit field declarations + assignment instead. (This already bit
  `session-lock.ts` and the error classes — keep that style.)
- Imports use explicit `.ts` extensions (e.g. `from "./runtime-manager.ts"`),
  required by Node's resolver here.
- The frontend is built by Vite. **`vite build` transpiles but does not
  type-check** — always run `npx tsc --noEmit` to actually verify frontend types.

## Verify before declaring done

```bash
npx tsc --noEmit         # frontend type check (Vite won't catch type errors)
npx vite build           # frontend builds
node lock-test.ts        # lock protocol units (17)
# E2E need the backend up:
node server/index.ts & sleep 2
node e2e-lock.ts && node e2e-sse.ts && node e2e-sse-lock.ts
pkill -f "node server/index.ts"
```

When running the backend from a script, launch it with `nohup ... > log 2>&1 &`
and poll the log — running it in the foreground blocks the shell (the server
doesn't exit). Always `pkill -f "node server/index.ts"` when done so the next
run doesn't hit a port-in-use.

## Frontend conventions (Cloudscape)

- Use the **`cloudscape` skill**: pull component APIs/guides with `curl` from
  `cloudscape.design` (the `.json`/`.md` endpoints) rather than guessing prop
  names. Don't use a WebFetch-style tool — it compacts/truncates and corrupts
  exact APIs.
- Components are **controlled**: wire `value`/`onChange` (or the component's
  specific pair). Don't hand-roll layout — use `AppLayout`, `SpaceBetween`,
  `Box`, `Header`.
- SideNavigation drives navigation: directories are `expandable-link-group`
  items, sessions are nested `link` items. Custom fields (`cwd`, `sessionPath`)
  are injected onto items and read back from `onChange`/`onFollow` event detail.
- Conditional JSX uses `cond ? (<X/>) : null` — note the `: null`. (A stray
  `) null}` without the colon is a syntax error that has happened here.)

## Event flow (frontend ↔ backend)

`useSession.ts` is where streaming is assembled:
- On mount: `api.session(path)` for scrollback, then `subscribeEvents(path)`.
- SSE events accumulate into a streaming assistant message: `message_update`
  (`text_delta` / `thinking_delta` / `toolcall_end`), `tool_execution_*`,
  `message_end`, `agent_end`.
- `send()` is optimistic (appends the user message immediately), then POSTs
  `prompt`. A `409` → lock conflict state → the UI shows a Force-takeover banner.

If you add a new SSE event type on the backend, handle it in `useSession.ts`'s
`handleEvent` switch or it's silently dropped.

## Scope discipline

- pi-web is a host + UI. Agent behavior, tools, and per-session policy belong in
  **extensions** (in pi-skills), not here. Don't reimplement agent internals.
- "Watch another process's live writes" (jsonl file watcher) is intentionally
  out of scope — pi-web only streams runtimes it owns. Don't add it without a
  deliberate decision.
