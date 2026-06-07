# pi-gui

A web and desktop UI for [pi](https://github.com/earendil-works/pi) that lets
you browse and chat across **multiple directories and multiple sessions at
once** — something the single-session TUI can't do. Runs in the browser or as a
native desktop app (Tauri) that bundles its own Node runtime.

It's a thin host layer on top of pi's SDK (`@earendil-works/pi-coding-agent`):

- **Browsing is free.** Listing directories, listing sessions, and reading a
  session's scrollback are pure file reads — no agent runtime is spawned.
- **Live chat is on-demand.** A pi runtime spins up only when you actually send
  a prompt to a session. Many sessions can be live at once, each streaming
  independently over SSE.
- **One writer per session.** A session file has no OS lock in pi, so concurrent
  writes would corrupt it. pi-gui and the pi TUI share an advisory lock protocol
  (`session-lock`) so a given session is only ever *written* from one place.
  Viewing is always allowed; only sending requires the lock.
- **The web mirrors the TUI.** pi-gui reads whatever TUI extensions leave in the
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
session, and pi-gui symlinks the same file so both speak the exact same protocol
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
- pi-gui re-checks ownership **before every prompt** (`isMine()`); if taken, the
  prompt is rejected (`409 revoked`) and the runtime dropped.
- Opening a locked session returns `409 locked` with the current holder; the UI
  offers a **Force takeover** button (demotes the other side to read-only).

## Features

- Multi-directory / multi-session sidebar (drill-down: directory → sessions),
  resizable + collapsible.
- Multiple concurrent session tabs, each streaming live over a single
  multiplexed WebSocket. Tabs stay mounted so background sessions keep their
  subscription.
- Chat UI with markdown rendering (unified: remark/rehype + sanitize), thinking
  preview, compact collapsible tool calls, per-message model · elapsed · time.
  Auto-retry (rate-limit/timeout) shows a live countdown, context compaction
  shows a spinner, and aborted/errored turns surface their error — all mirroring
  the TUI.
- Per-session **info panel**: an always-open, resizable/collapsible right side
  panel with tabs — **Info** (model picker, thinking level, context usage + token
  breakdown, rename, raw stats), **Subagents**, **Tasks** (goal + todo), and
  **Git**.
- **Footer** mirroring the TUI: pwd (git branch) · name, token/cost/context,
  model · thinking, ownership, plus goal status and `n/N todos`.
- **Goal & todo** (from the pi-skills `goal`/`todo` extensions): an aboveEditor
  todo widget while the agent works, an `n/N todos` + goal-status footer line,
  and a **Tasks** info-panel tab — surfaced by a GUI-only in-process extension,
  no polling.
- **Slash commands**: extension commands + skills (`/skill:name`) with `/`
  autocomplete, plus a builtin `/reload` to reload extensions/skills; executed
  through the normal prompt flow.
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
git clone --recursive https://github.com/HaDaSimSim/pi-gui.git
# (already cloned without --recursive? run: git submodule update --init)
pnpm install         # installs deps incl. @earendil-works/pi-coding-agent (registry)
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

- `@earendil-works/pi-coding-agent` (and `@earendil-works/pi-ai`) are normal
  versioned dependencies installed from the npm registry (currently `0.78.0`).
  They require Node `>=22.19.0`. Bump the version in `package.json` and re-run
  `pnpm install` to update.
- `shared/session-lock.ts` is a symlink into the vendored **pi-skills** submodule
  (`vendor/pi-skills/`). Clone with `git clone --recursive`, or run
  `git submodule update --init` after cloning, or the symlink dangles and the
  backend won't boot. `pnpm bundle:backend` materializes it into a real file in
  the shipped `dist-backend/`.
- Model keys / auth come from pi's own `~/.pi/agent/auth.json` + `models.json`
  via `AuthStorage`/`ModelRegistry`. pi-gui doesn't manage credentials.

## Layout

```
pi-gui/
├── server/             Hono backend — routes, locks, UI bridge, git (see server/README.md)
├── web/                React + shadcn frontend (see web/README.md)
├── src-tauri/          Rust/Tauri desktop shell + bundled node (see src-tauri/README.md)
├── scripts/            build scripts (fetch-node, bundle-backend, gen-notices, finalize-bundle)
├── shared/             session-lock.ts → symlink → vendor/pi-skills lock protocol
├── vendor/pi-skills/   git submodule (lock protocol source of truth)
├── test/               unit + E2E (see Tests)
├── components.json     shadcn config (@/ → web/)
└── vite.config.ts      dev proxy /api/ → 4317, @/ alias
```

Each of `server/`, `web/`, and `src-tauri/` has its own `README.md` (what it is)
and `AGENTS.md` (load-bearing invariants). This root pair covers cross-cutting
rules; the subdir docs go deeper and defer up to here.

## Desktop app (Tauri)

pi-gui ships as a native desktop app via Tauri. The Rust shell
(`src-tauri/`) is a thin wrapper: on launch it **spawns the Node backend as a
child process on a dynamic port** and kills it on exit. The WebView loads the
built frontend and talks to that backend.

- **Dynamic port (no collisions).** The backend is spawned with `PORT=0`, so the
  OS picks a free port; the backend prints `PI_GUI_PORT=<n>` on stdout, the Rust
  side parses it and injects `window.__PI_GUI_PORT__` into the WebView. This is
  why two instances (or a leftover dev backend) never fight over 4317.
- In Tauri **prod** the WebView origin is `tauri://`, so relative `/api` won't
  reach the backend — `web/config.ts` builds an absolute base
  (`http://127.0.0.1:<injected port>`) and `waitForBackendPort()` holds startup
  until the port arrives. In Tauri **dev** it stays on the Vite proxy (relative).
- CSP `connect-src` allows `http://127.0.0.1:*` (any local port) since the port
  is dynamic.
- **New-directory uses the native folder dialog** in Tauri
  (`@tauri-apps/plugin-dialog`, returns an absolute path); the browser build
  falls back to the server-side directory browser modal.
- Backend spawn is env-tunable: `PI_GUI_PORT` (force a port; default `0` = OS
  picks), `PI_GUI_NODE` (node binary), `PI_GUI_BACKEND_ENTRY` (dev: path to
  `server/index.ts`), `PI_GUI_NO_SPAWN` (don't spawn — attach to an
  already-running backend, used by `tauri:dev`).

```bash
pnpm tauri:dev     # starts backend (4317, dev) + tauri dev (WebView on vite 5173)
pnpm tauri:build   # bundles dist-backend, builds frontend, packages the .app
```

`pnpm bundle:backend` assembles `dist-backend/` (server + shared + runtime
node_modules, with the pi SDK dereferenced from the pnpm store) which Tauri ships
as a resource. It's ~200MB; the bundle is built from your installed node_modules.
`pnpm bundle:backend` also regenerates `THIRD-PARTY-NOTICES.md` from the bundled
packages.

### Installing a built app (unsigned)

The `.app`/`.dmg` produced by `pnpm tauri:build` is **not code-signed or
notarized**. On first launch macOS Gatekeeper will warn that the app is from an
unidentified developer (or "damaged"). To open it:

- Right-click the app → **Open** → confirm, or
- Remove the quarantine attribute: `xattr -dr com.apple.quarantine "/Applications/π (pi).app"`

To distribute a signed build you need an Apple Developer ID and notarization
credentials wired into the Tauri bundle config; that is intentionally not set up
here.

### Runtime requirements for an installed app

The app is a UI host for pi, not a standalone bundle. On the machine running it:

- **pi must be installed and initialized** (`~/.pi/agent` exists) with at least
  one model/provider configured (`auth.json` or `models.json`). pi-gui reads
  credentials and sessions from there; it manages none itself.
- A recent **Node (>=22.19)** must be reachable. The Rust shell spawns the
  bundled backend with the system `node`; macOS GUI apps don't inherit your
  shell `PATH`, so if `node` isn't found, set `PI_GUI_NODE` to an absolute path.
  (A bundled Node runtime is planned to remove this requirement.)
- `git` on `PATH` is optional (enables the branch/status panel).

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
  pi-gui only streams runtimes it owns. A foreign session's live writes would
  need a jsonl file watcher (deliberately out of scope).
- Extension `ctx.ui.custom` (arbitrary terminal component) has no generic web
  mapping. The generic bridge covers confirm/select/input/editor/notify;
  extensions using `custom` (btw, questionnaire, subagents' run overlay) need a
  bespoke web renderer each — subagent runs already render inline read-only.
  web; each needs a dedicated web renderer.
