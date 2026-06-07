# AGENTS.md — src-tauri (Rust desktop shell)

How-to-work-here for the Tauri shell. See [`README.md`](./README.md) for what it
does, and the **root** [`AGENTS.md`](../AGENTS.md) ("Tauri (desktop shell)") for
repo-wide rules that this directory inherits. English-only comments and docs,
same as the rest of the repo.

## Hard rules (load-bearing)

- **The backend stays Node — do not port it to Rust.** The backend uses pi's SDK
  (`@earendil-works/pi-coding-agent`), which is TS/Node. Rust's only job is to
  spawn that Node process, wire the dynamic-port handshake, and kill it on exit.
  Don't try to reimplement runtime/session logic here.

- **`resolve_node()` order is `PI_GUI_NODE` > sidecar > `PATH`, and it matters.**
  A launched macOS `.app` does **not** inherit the shell `PATH`, so a system
  `node` is usually unreachable. The bundled sidecar
  (`Contents/MacOS/node`) must be preferred. Don't reorder it to look at `PATH`
  first.

- **The node sidecar must be ad-hoc signed after `lipo`.** `lipo` fuse
  invalidates code signatures; an unsigned universal node gets "killed: 9" on
  Apple Silicon. `scripts/fetch-node.ts` re-signs all three binaries
  (`codesign --force --sign -`). Don't drop that step.

- **`externalBin` must exist before `tauri build`.** `tauri.conf.json` declares
  `binaries/node`; if the `binaries/node-*-apple-darwin` files are missing the
  Rust build fails. Run `pnpm fetch:node` first (the `tauri:build` script does).

- **`dist-backend/` must exist before `tauri build`.** `tauri.conf.json` lists
  `../dist-backend` as the `backend` resource; a missing dir fails the build.
  Run `pnpm bundle:backend` first (the `tauri:build` script does).

- **Dynamic port — never hardcode it in prod.** The backend is spawned with
  `PORT=0`; the Rust stdout reader parses `PI_GUI_PORT=<n>` and injects
  `window.__PI_GUI_PORT__`. Don't replace this with a fixed port, and keep CSP
  `connect-src` as `http://127.0.0.1:*` (wildcard port) in `tauri.conf.json` — a
  fixed port there would CSP-block every request.

- **Backend binds `127.0.0.1` only.** Wrapping it in Tauri doesn't change that.
  Don't add a network listener or change the bind host without auth (see root
  `AGENTS.md`).

## Window / menu

- Window is `titleBarStyle: "Overlay"` + `hiddenTitle`. The frontend's
  `data-tauri-drag-region` strip reserves space for the macOS traffic lights —
  don't remove it on either side or content sits under the buttons.
- Window close (red X) hides the window (`prevent_close` + `hide`), it does not
  quit. Real quit goes through `ExitRequested`, which shows a confirmation when a
  session is live (`Busy`/`set_busy`) and then kills the backend `Child`. The
  `QUITTING` flag prevents re-entry after the confirmation passes.

## Parent-death watchdog interplay

The Node backend self-exits when its parent dies (it polls
`PI_GUI_PARENT_PID`, which Rust sets to its own PID on spawn). This kills
orphaned backends. But `nohup`-launched test backends get reparented to init,
which trips the watchdog — for those, set `PI_GUI_NO_PARENT_WATCH=1` (see root
`AGENTS.md` "Verify before declaring done"). Don't remove the
`PI_GUI_PARENT_PID` env on spawn.

## Rust gotchas

- Edition 2021, `rust-version` 1.77.2, `rustfmt` `max_width = 100`.
- Tauri v2 with `tauri-plugin-shell` and `tauri-plugin-dialog`. The dialog plugin
  backs both the quit confirmation and the native folder picker.
- Backend spawn is env-tunable: `PI_GUI_PORT`, `PI_GUI_NODE`,
  `PI_GUI_BACKEND_ENTRY`, `PI_GUI_NO_SPAWN` (see README).

## Versioning

`package.json` is the single source of truth. `tauri.conf.json` points at
`../package.json` and inherits it. `Cargo.toml`'s `version` is **not**
auto-synced and is display-only; `scripts/finalize-bundle.ts` warns (does not
fail) if it drifts. Don't rely on `Cargo.toml` for the shipped version.

## Build / verify

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml   # rustfmt
pnpm tauri:build                                  # full bundle (see README)
```

`tauri:build` runs `fetch:node` → `bundle:backend` → `tauri build` →
`finalize-bundle.ts` (dmg rename). The app is unsigned / not notarized;
Gatekeeper warns on first launch.
