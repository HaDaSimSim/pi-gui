# src-tauri — pi-gui desktop shell

The native desktop wrapper for pi-gui, built with [Tauri v2](https://tauri.app).
It is deliberately thin: the Rust side spawns the Node backend
(`server/index.ts`, Hono + pi SDK) as a child process, loads the built frontend
in a WebView, and shuts the backend down on exit. All real work — agent
runtimes, session files, locks — lives in the Node backend, not here.

For repo-wide context and the web/backend design, see the root
[`README.md`](../README.md) ("Desktop app (Tauri)") and
[`AGENTS.md`](../AGENTS.md) ("Tauri (desktop shell)"). This doc covers only the
Rust shell.

## What the shell does

- **Spawns the backend as a child.** On `setup`, `spawn_backend` launches
  `node server/index.ts` and stores the `Child` handle. On
  `RunEvent::ExitRequested` it `kill()`s that child, so quitting the app never
  leaves an orphaned backend.
- **Loads the frontend in a WebView.** In prod the WebView serves
  `../dist-web`; the frontend talks to the backend over HTTP/SSE.
- **Window close ≠ quit.** Clicking the window's red X calls
  `api.prevent_close()` and hides the window — tab/session state stays in
  memory. Actual quit (Cmd+Q, dock → Quit) goes through `ExitRequested`, which
  (after a confirmation dialog if a session is live) kills the backend and
  exits.
- **Menu bar + DevTools.** A macOS menu bar is built in `build_menu`, including
  a DevTools toggle (Cmd+Opt+I) and a Backend Log shortcut (Cmd+Shift+L) for
  diagnosing the backend/frontend.

## Bundled-node sidecar model

macOS GUI apps do **not** inherit the shell `PATH`, so a system `node` often
isn't findable from a launched `.app`. To avoid that, pi-gui ships its own Node
runtime as a Tauri `externalBin` sidecar.

- `pnpm fetch:node` (`scripts/fetch-node.ts`) downloads the pinned Node
  (`v22.20.0`, ≥22.19 for native TS stripping) for arm64 + x64, verifies
  SHASUMS256, `lipo`-fuses a universal binary, then **ad-hoc codesigns all
  three** (lipo invalidates signatures; without re-signing, Apple Silicon kills
  the binary with "killed: 9"). Output: `binaries/node-{aarch64,x86_64,universal}-apple-darwin`.
- `resolve_node()` picks the Node executable in this order:
  1. `PI_GUI_NODE` — explicit override (test/dev),
  2. a `node` sidecar next to the main executable
     (`Contents/MacOS/node` in a prod `.app`; `target/<profile>/node` in a
     per-arch dev build),
  3. `node` on `PATH` — last-resort fallback.

  The sidecar is preferred over `PATH` precisely because the launched app has no
  shell `PATH`.

## Dynamic-port handshake

The backend port is never fixed in prod, so two instances (or a leftover dev
backend) can't collide on a port.

1. The backend is spawned with `PORT=0`, so the OS picks a free port.
2. The backend prints `PI_GUI_PORT=<n>` on stdout.
3. A reader thread parses that line, emits a `pi-gui://port` event, and injects
   `window.__PI_GUI_PORT__ = <n>` into the WebView via `win.eval(...)`.
4. The frontend (`web/config.ts`) builds an absolute base
   `http://127.0.0.1:<injected port>` for its `fetch`/`EventSource` calls.

stdout and stderr are also tee'd to `backend.log` in the app log dir, so a
windowless prod app can still be diagnosed.

## Dev vs prod

- **`pnpm tauri:dev`** starts its own backend (`node --watch server/index.ts` on
  the dev-fixed port 4317) and runs `tauri dev` with `PI_GUI_NO_SPAWN=1`, so the
  Rust side does *not* double-spawn. The WebView (Vite on 5173) uses the
  relative-path proxy. A running `pnpm dev` collides with this on 4317/5173 —
  stop one first.
- **Prod** (the built `.app`) spawns its own backend from the bundled
  `../dist-backend` resource (mounted as `backend/`) on a dynamic port via the
  handshake above.

Backend spawn is env-tunable: `PI_GUI_PORT` (force a port; default `0`),
`PI_GUI_NODE` (node binary), `PI_GUI_BACKEND_ENTRY` (dev: path to
`server/index.ts`), `PI_GUI_NO_SPAWN` (attach to an already-running backend).

## Build flow

```bash
pnpm tauri:build
# = pnpm fetch:node && pnpm bundle:backend && tauri build && node scripts/finalize-bundle.ts
```

- `fetch:node` materializes the Node sidecars into `binaries/` (required —
  `externalBin` must exist or `tauri build` fails).
- `bundle:backend` assembles `../dist-backend/` (server + shared + runtime
  node_modules with the pi SDK dereferenced); `tauri.conf.json` ships it as the
  `backend` resource. The Rust build fails if `dist-backend/` is missing.
- `tauri build` packages the `app` and `dmg` targets. `productName` is `pi` and
  the version is inherited from `../package.json` (`tauri.conf.json` points at
  it). `Cargo.toml`'s version is display-only and is *not* auto-synced —
  `finalize-bundle.ts` warns if it drifts.
- `finalize-bundle.ts` also renames the dmg from the productName-derived name to
  `pi-gui_<ver>_<arch>.dmg` (Tauri v2 has no dmg-specific filename option).

**Signing.** The app is **unsigned / not notarized**. The bundled node carries
ad-hoc signatures plus JIT entitlements (`Entitlements.plist`:
`allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation`). Gatekeeper will warn on first launch.
