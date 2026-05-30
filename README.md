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

## Architecture

```
browser (React + Cloudscape)
   │  /api/* (REST)  +  /api/session/events (SSE)
   ▼
server/ (Hono, 127.0.0.1 only)
   ├── index.ts            HTTP routes + SSE
   └── runtime-manager.ts  sessionPath → live AgentSession; subscription channels; locks
   │
   ├─ reads  → SessionManager.listAll() / list(cwd) / open(path)   (no runtime)
   ├─ writes → createAgentSession(...) per live session            (runtime + lock)
   └─ lock   → shared/session-lock.ts  (symlink to the pi-skills source of truth)
```

The lock protocol lives in **pi-skills**
(`pi-skills/extensions/session-lock/shared/session-lock.ts`) and is consumed two
ways:

- the **pi-skills `session-lock` extension** claims the lock when the pi TUI/CLI
  opens a session, and
- **pi-web** symlinks the same file (`shared/session-lock.ts`) so both speak the
  exact same protocol and can see each other's claims.

## Cost model (why it scales)

| Action | Runtime? | Lock? |
|---|---|---|
| List directories / sessions | no | no |
| Read a session (scrollback) | no | no |
| Subscribe to live events (SSE) | no | no |
| Send a prompt | **yes** (lazy, 1 per session) | **yes** (exclusive) |

Idle runtimes are reaped after 5 minutes. So you can fan out a huge sidebar of
directories and sessions for free; only the sessions you actually talk to cost a
runtime.

## Lock model

- Exclusive, no auto-expiry. A session is held until the owner releases it or
  someone **force-takes** it.
- `state()` is one of `free` / `mine` / `lost`. "lost" means you held it but the
  on-disk token changed (someone took over) or the lock vanished.
- pi-web re-checks ownership **before every prompt** (`isMine()`); if it was
  taken, the prompt is rejected (`409 revoked`) and the runtime is dropped.
- Opening a locked session returns `409 locked` with the current holder; the UI
  offers a **Force takeover** button (demotes the other side to read-only).

## Run

```bash
pnpm install         # links @earendil-works/pi-coding-agent (see Setup)
pnpm dev             # backend (4317) + Vite dev server (5173) together
# open http://127.0.0.1:5173
```

Or run the pieces separately:

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
  `node_modules/@earendil-works/pi-coding-agent`). If you move pi or install it
  to a different global prefix, update the `link:` path in `package.json` and
  re-run `pnpm install`.
- `shared/session-lock.ts` is a symlink into the pi-skills repo. If that repo
  moves, re-point the symlink.
- Model keys / auth come from pi's own `~/.pi/agent/auth.json` + `models.json`
  via `AuthStorage`/`ModelRegistry`. pi-web doesn't manage credentials.

## Project layout

```
pi-web/
├── server/
│   ├── index.ts            Hono app: routes + SSE
│   └── runtime-manager.ts  runtime lifecycle, subscription channels, lock guard
├── web/                    React + Cloudscape frontend
│   ├── main.tsx            entry (Cloudscape global styles + UI-settings boot)
│   ├── App.tsx             HashRouter shell (routes → Layout → pages)
│   ├── Layout.tsx          TopNavigation chrome (Sessions ⇄ Settings) + <Outlet/>
│   ├── SessionsPage.tsx    AppLayout + SideNavigation(dirs→sessions) + Tabs(multi-session)
│   ├── SettingsPage.tsx    appearance (theme/density/motion) + read-only models/locks/live
│   ├── useUiSettings.ts    browser-side UI settings (localStorage → Cloudscape global styles)
│   ├── SessionTab.tsx      one session: messages + PromptInput + lock-conflict banner
│   ├── MessageView.tsx     message render (text/thinking/tool calls)
│   ├── useSession.ts       per-session live state hook (scrollback + SSE deltas + send)
│   └── api.ts              typed backend client + SSE subscription
├── shared/
│   └── session-lock.ts     → symlink → pi-skills lock protocol (source of truth)
├── vite.config.ts          dev proxy /api → 4317
├── poc.mjs                 SDK proof-of-concept (listAll, multi-runtime streaming)
├── lock-test.ts            lock protocol unit tests
├── e2e-lock.ts             server-level lock E2E
├── e2e-sse.ts              SSE live-streaming E2E (real model)
└── e2e-sse-lock.ts         "view without lock, write needs lock" E2E
```

## Tests

```bash
node lock-test.ts        # lock protocol units (17)
# the E2E scripts need the backend running:
node server/index.ts &   # then, in another shell:
node e2e-lock.ts         # lock enforcement (9)
node e2e-sse.ts          # live streaming, real model (11)
node e2e-sse-lock.ts     # view-vs-write lock separation (7)
```

## Known rough edges

- Frontend bundle is a single ~845 KB chunk (Cloudscape). Code-splitting not
  done yet.
- "Live activity from *another* process (the TUI)" is not streamed into pi-web —
  pi-web only streams runtimes it owns. Watching a foreign session's writes live
  would need a jsonl file watcher (deliberately out of scope for now).
- No production static-serving route on the backend yet; dev uses the Vite
  proxy. For a single-process deploy, add a static handler for `dist-web/`.
