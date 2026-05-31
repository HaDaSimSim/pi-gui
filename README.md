# pi-web

A web UI for [pi](https://github.com/earendil-works/pi) that lets you browse and
chat across **multiple directories and multiple sessions at once** — something
the single-session TUI can't do.

It's a thin host layer on top of pi's SDK (`@earendil-works/pi-coding-agent`):

- **Browsing is free.** Listing directories, listing sessions, and reading a
  session's scrollback are pure file reads — no agent runtime is spawned.
- **Live chat is on-demand.** A pi runtime spins up only when you actually send
  a prompt to a session. Many sessions can be live at once, each streaming
  independently over SSE.
- **One writer per session.** A session file has no OS lock in pi, so concurrent
  writes would corrupt it. pi-web and the pi TUI share an advisory lock protocol
  (`session-lock`) so a given session is only ever *written* from one place.
  Viewing is always allowed; only sending requires the lock.
- **The web mirrors the TUI.** pi-web reads whatever TUI extensions leave in the
  session file (turn timing, token/cost, slash commands, skills) and renders it
  itself. Extensions stay TUI-only; the web adapts to them.

## Architecture

```
browser (React + shadcn/ui + Tailwind v4)
   │  /api/* (REST)  +  /api/session/events (SSE)
   ▼
server/ (Hono, 127.0.0.1 only)
   ├── index.ts            HTTP routes + SSE (+ static serve of dist-web in prod)
   ├── runtime-manager.ts  sessionPath → live AgentSession; subscription channels; locks
   └── web-ui-context.ts   ExtensionUIContext bridge (ctx.ui.* → SSE → browser)
   │
   ├─ reads  → SessionManager.listAll() / list(cwd) / open(path)   (no runtime)
   ├─ writes → createAgentSession(...) per live session            (runtime + lock)
   └─ lock   → shared/session-lock.ts  (symlink to the pi-skills source of truth)
```

The lock protocol lives in **pi-skills**
(`pi-skills/extensions/session-lock/shared/session-lock.ts`) and is consumed two
ways: the pi-skills `session-lock` extension claims it when the TUI/CLI opens a
session, and pi-web symlinks the same file so both speak the exact same protocol
and can see each other's claims.

## Cost model (why it scales)

| Action | Runtime? | Lock? |
|---|---|---|
| List directories / sessions | no | no |
| Read a session (scrollback) | no | no |
| Subscribe to live events (SSE) | no | no |
| Footer token/cost summary | no | no |
| Git status / branches / log (`/api/git`) | no | no |
| Delete a session (file remove) | no | no (refuses if live/locked) |
| Send a prompt / open / new | **yes** (lazy, 1 per session) | **yes** (exclusive) |
| Change model / thinking / rename / abort | **yes** | **yes** |

Idle runtimes are reaped after 5 minutes. You can fan out a huge sidebar of
directories and sessions for free; only the sessions you actually talk to cost a
runtime.

## Lock model

- Exclusive, no auto-expiry. Held until the owner releases or someone
  **force-takes** it.
- `state()` is `free` / `mine` / `lost`. "lost" = you held it but the on-disk
  token changed (someone took over) or the lock vanished.
- pi-web re-checks ownership **before every prompt** (`isMine()`); if taken, the
  prompt is rejected (`409 revoked`) and the runtime dropped.
- Opening a locked session returns `409 locked` with the current holder; the UI
  offers a **Force takeover** button (demotes the other side to read-only).

## Features

- Multi-directory / multi-session sidebar (drill-down: directory → sessions),
  resizable + collapsible.
- Multiple concurrent session tabs, each streaming live over SSE. Tabs stay
  mounted so background sessions keep their SSE subscription.
- Chat UI with markdown rendering (unified: remark/rehype + sanitize), thinking
  preview, compact collapsible tool calls, per-message model · elapsed · time.
- Per-session **info panel**: an always-open, resizable/collapsible right side
  panel with tabs — **Info** (model picker, thinking level, context usage + token
  breakdown, rename, raw stats), **Subagents**, and **Git**.
- **Footer** mirroring the TUI: pwd (git branch) · name, token/cost/context,
  model · thinking, ownership.
- **Slash commands**: extension commands + skills (`/skill:name`) with `/`
  autocomplete; executed through the normal prompt flow.
- Composer: file attach + paste screenshots (clipboard images). Stop button
  aborts an in-flight response.
- Subagent runs (from the pi-skills `subagents` extension) render in the info
  panel's **Subagents** tab as collapsible cards (title · agent · status · turns).
- Session management: create new session / directory, delete a session
  (refuses while it's live or locked elsewhere).
- **Extension UI bridge**: `ctx.ui.confirm/select/input/editor` render as shadcn
  dialogs and `ctx.ui.notify` as toasts, so interactive extensions (e.g.
  session-lock's takeover confirm) work in the browser.
- **Git panel** (read-only): a tab in the info panel showing current branch +
  ahead/behind, changed files (staged/unstaged/untracked), local branches, and a
  recent commit graph. Pure `git` reads via `/api/git` — no runtime, no writes.
- Settings modal: language (en/ko), theme (light / dark / true-dark),
  density, motion, configurable UI + monospace fonts; read-only models / locks /
  live-runtime tables.
- Production single-process serve: `pnpm build && pnpm start` serves the built
  `dist-web/` from the Hono backend (static + SPA fallback) on `127.0.0.1:4317`.
  In dev, Vite serves the frontend and proxies `/api/`.

## Run

```bash
pnpm install         # links @earendil-works/pi-coding-agent (see Setup)
pnpm dev             # backend (4317) + Vite dev server (5173) together
# open http://127.0.0.1:5173
```

Run the pieces separately:

```bash
pnpm dev:server      # Hono backend on 127.0.0.1:4317
pnpm dev:web         # Vite dev server on 127.0.0.1:5173 (proxies /api → 4317)
pnpm build:web       # production bundle → dist-web/
```

> **Security:** the backend binds to `127.0.0.1` only. It has full local shell,
> file, and model-key access through pi's SDK — treat it like a local root
> shell. Do **not** expose it to a network without adding authentication first.

## Setup notes

- `@earendil-works/pi-coding-agent` is consumed from the globally installed pi
  via a pnpm `link:` dependency (an absolute path to the global
  `node_modules/@earendil-works/pi-coding-agent`). If you move pi or change the
  global prefix, update the `link:` path in `package.json` and re-run
  `pnpm install`.
- `shared/session-lock.ts` is a symlink into the pi-skills repo. If that repo
  moves, re-point the symlink.
- Model keys / auth come from pi's own `~/.pi/agent/auth.json` + `models.json`
  via `AuthStorage`/`ModelRegistry`. pi-web doesn't manage credentials.

## Layout

```
pi-web/
├── server/             Hono backend (index.ts routes/SSE/static, runtime-manager.ts locks, web-ui-context.ts ui bridge, git.ts read-only git)
├── web/                React + shadcn frontend (kebab-case files; ui/ = shadcn components)
├── shared/             session-lock.ts → symlink → pi-skills lock protocol
├── test/               unit + E2E (see Tests)
├── components.json     shadcn config (@/ → web/)
└── vite.config.ts      dev proxy /api/ → 4317, @/ alias
```

## Tests

```bash
pnpm typecheck          # tsc --noEmit (Vite build does NOT type-check)
pnpm build:web          # vite build
pnpm test:unit          # lock units (17) + i18n parity (8), no server needed

# E2E need the backend up. Use a non-default port so you never collide with a
# running dev server on 4317:
PORT=4318 nohup node server/index.ts > /tmp/piweb.log 2>&1 & sleep 2
PORT=4318 pnpm test:e2e   # e2e-lock (9) + e2e-sse (11, real model) + e2e-sse-lock (7)
lsof -ti :4318 | xargs kill
```

`test/poc.mjs` is an SDK proof-of-concept (listAll + multi-runtime streaming),
not part of the suite.

## Known rough edges

- Live activity from *another* process (the TUI) is not streamed in real time —
  pi-web only streams runtimes it owns. A foreign session's live writes would
  need a jsonl file watcher (deliberately out of scope).
- Extension `ctx.ui.custom` (arbitrary terminal component) has no generic web
  mapping. The generic bridge covers confirm/select/input/editor/notify;
  extensions using `custom` (btw, questionnaire, subagents' run overlay) need a
  bespoke web renderer each — subagent runs already render inline read-only.
  web; each needs a dedicated web renderer.
