# AGENTS.md

How-to-work-here for **pi-gui**. Read `README.md` for what/why.

## Hard rules (load-bearing, not discoverable)

- **Backend binds to `127.0.0.1` only.** Never change the bind host or add a
  network listener without adding auth in the same change. This process has full
  local shell/file/model-key access via pi's SDK.
- **The lock guard is load-bearing.** `RuntimeManager.prompt()` re-checks
  `lock.isMine()` *before every send*. Do not move, cache, or skip it — it's the
  only thing preventing two writers from corrupting a session jsonl (pi puts no
  OS lock on session files).
- **Browsing must never spawn a runtime.** `/api/directories`, `/api/sessions`,
  `/api/session`, `/api/session/footer`, `/api/git`, and SSE subscription are
  pure file reads. Only `prompt`/`open`/`new` + the control routes (`model`,
  `thinking`, `rename`, `abort`, `ui-response`) create or touch a runtime + lock. That
  separation is the cost model the whole design rests on. (`DELETE /api/session`
  is a file delete, not a runtime op — it refuses if the session is live/locked.)
- **The UI bridge must stay bound.** `RuntimeManager.getOrCreate` binds a
  `WebUIContext` via `session.bindExtensions({ uiContext })` so extension
  `ctx.ui.confirm/select/input/notify` work. Without it `hasUI` is false and
  interactive extensions either degrade or hang. Pending requests are cancelled
  on `dispose` (`ui.cancelAll`) — don't drop that or a disposed session leaks a
  forever-pending promise.
- **`shared/session-lock.ts` is a symlink, not a copy.** Source of truth is
  `pi-skills/extensions/session-lock/shared/session-lock.ts`. Edit the protocol
  *there* — the pi TUI extension and pi-gui must stay byte-identical.
- **The lock owner identifier stays `"pi-web"`.** Although the project/repo is now
  pi-gui, the SessionLock owner string (in `runtime-manager.ts`), the `owner`
  union type, and the on-disk folder are intentionally still `pi-web` — they're
  protocol/identity values the pi TUI matches against. Only display names,
  comments, and the repo name changed to pi-gui.

## Runtime / TypeScript gotchas

- Backend runs under Node native TS stripping (`node server/index.ts`).
  **Strip-only mode forbids parameter properties** (`constructor(private x: T)`)
  and anything needing code emit. Use explicit field declarations + assignment.
- Server-side imports need explicit `.ts` extensions (`from "./x.ts"`).
- `pi-ai` is not a direct dependency (nested under pi-coding-agent). Don't import
  it; re-declare small types locally (see `ImageContent` in `runtime-manager.ts`).
- **`vite build` does not type-check.** Always run `pnpm typecheck` separately.
- Production = single process: `pnpm build && pnpm start`. The backend serves
  `dist-web/` (static + SPA fallback) **only when that dir exists**; in dev it
  doesn't, so Vite serves the frontend and proxies `/api/`. The Vite proxy key
  is `/api/` (trailing slash) on purpose — `/api` alone also matches the
  frontend's own module URLs.

## Frontend gotchas

- `@/` aliases `web/` (not `web/` being a `src` root) — set in both
  `vite.config.ts` and `tsconfig.json`. Keep them in sync.
- shadcn's ScrollArea (Radix) wraps content in a `display:table` div that breaks
  `truncate` and overflows. The viewport override (`[&>div]:!w-full` etc.) in
  `components/ui/scroll-area.tsx` is intentional — don't revert it.
- `react-resizable-panels` here is **v4** (`Group`/`Panel`/`Separator`,
  `usePanelRef`, `orientation` not `direction`, no `onCollapse`/`autoSaveId`).
  The shadcn wrapper names are aliased in `components/ui/resizable.tsx`.
- Textarea `onKeyDown` guards `e.nativeEvent.isComposing || keyCode === 229`
  before Enter-to-send, or Korean/IME loses the last char. Don't remove it.
- True-dark theme uses Tailwind `.dark.true-dark` token overrides, applied via
  the `<html>` class in `use-ui-settings.ts`. Not Cloudscape's applyTheme.

## i18n

- `web/i18n.ts` is a flat dict, `en` is the source of truth, `ko` must mirror its
  key set exactly. After touching it, verify parity (en count === ko count).
- Owner labels in the lock/settings UI are intentionally English-only (not i18n'd).

## Mirroring the TUI

pi-gui reads what TUI extensions leave in the session file and renders it itself;
extensions never need to know about web. Already wired:
- `turn-meta` custom entries (ui-cosmetics) → per-message elapsed time.
- `subagent-run` custom entries (subagents) → inline collapsible run blocks.
- footer token/cost = summed assistant `usage` from session entries.
- slash commands = `extensionRunner.getRegisteredCommands()` + skills from
  `resourceLoader.getSkills()`; executed by POSTing `/name` through the normal
  prompt flow (the SDK intercepts it).

The **UI bridge** (`web-ui-context.ts`) covers `ctx.ui.confirm/select/input/`
`editor/notify` generically (SSE → shadcn dialog/toast → `ui-response`). But
`ctx.ui.custom` is an arbitrary terminal component with no generic mapping —
extensions that use it (btw, question/questionnaire, subagents' run overlay) need
a bespoke web renderer each. All other terminal-only UI calls (`setWidget`,
`setFooter`, `onTerminalInput`, …) are safe no-ops in the bridge.

## Verify before declaring done

```bash
pnpm typecheck          # tsc --noEmit (Vite won't catch type errors)
pnpm build:web          # vite build (also code-splits: react/markdown/settings)
pnpm test:unit          # lock units (17) + i18n parity (8), no server needed
# E2E need the backend up. Use a NON-DEFAULT port so you never touch a
# user's running server on 4317:
PORT=4318 nohup node server/index.ts > /tmp/piweb.log 2>&1 & sleep 2
PORT=4318 pnpm test:e2e
lsof -ti :4318 | xargs kill
```

The server doesn't self-exit — launch with `nohup ... &` and poll the log;
running it in the foreground blocks the shell. **Never `import()` the backend to
"test boot"** — importing `server/index.ts` binds port 4317 as a side effect and
collides with a user's dev server. Use the PORT=4318 nohup pattern instead.

## Scope discipline

- pi-gui is host + UI. Agent behavior, tools, per-session policy belong in
  **pi-skills extensions**, not here.
- "Watch another process's live writes" (jsonl file watcher) is intentionally
  out of scope — pi-gui only streams runtimes it owns.
