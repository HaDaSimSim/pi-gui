# AGENTS.md

How-to-work-here for **pi-gui**. Read `README.md` for what/why.

## Architecture

pi-gui is a native macOS SwiftUI app that hosts `pi --mode rpc` directly.
Each session is a real NSWindow in a native tab group (Ghostty-style titlebar
tabs). The app owns the session lock as `owner="pi-web"` and spawns one pi
process per session window.

### Target structure (SwiftPM multi-target)

```
PiCore        (library, cross-platform + Linux)  — models, protocols, parsing
PiUI          (library, Apple-only)              — shared SwiftUI views
PiMac         (executable, macOS)                — host app (spawns pi, holds lock)
PiMobile      (library stub, iOS)                — future remote client
PiRelay       (executable stub, Linux)           — future self-host relay server
PiPushGateway (executable stub, Linux)           — future APNs push gateway
```

Dependency: PiMac → PiUI → PiCore. PiRelay/PiPushGateway → PiCore only.

### Key files

| File | Role |
|------|------|
| `SessionWindowController.swift` | One per session. NSWindowController owning RuntimeSession. Native tab group. |
| `RuntimeSession.swift` | RPC client + lock + streaming model. One pi process per runtime. |
| `RpcClient.swift` | Spawns pi, LF-framed JSON I/O over stdin/stdout. |
| `SessionLock.swift` | Port of the TUI lock protocol (owner="pi-web", SHA1 keying, PID-based staleness). |
| `AppModel.swift` | Browsing state (directories/sessions). No tab array — OS manages windows. |
| `Transcript.swift` | Parses session jsonl → TranscriptItem model. |

## Hard rules (load-bearing, not discoverable)

- **The lock guard is load-bearing.** `RuntimeSession.holdsLockForWrite()` is
  re-checked before EVERY write command (prompt/bash/rename/compact/abort/
  setModel/setThinking). Never send any RPC write while `lock == nil` or
  `!lock.isMine()`. This is the only thing preventing two writers from
  corrupting a session jsonl.

- **The owner string stays `"pi-web"`.** The SessionLock owner, the `owner`
  union type, and on-disk format are intentionally `pi-web` — the pi TUI's
  session-lock extension matches against it. Don't rename.

- **GUI apps don't inherit login PATH.** `RpcClient.start()` injects the pi
  binary's parent directory into PATH so `#!/usr/bin/env node` resolves. If
  you change how pi is spawned, preserve this.

- **Browsing must never spawn a runtime.** `openSession` is a pure file read
  (reloadFromFile). A pi process spawns lazily on first prompt submit via
  `ensureRuntimeStarted`. This is the cost model: idle open tabs are free.

- **Hostname comparison is case-insensitive.** Node `os.hostname()` and Swift
  `ProcessInfo.hostName` can differ in casing on the same machine. The lock's
  `isStaleRecord` compares `.caseInsensitiveCompare` so TUI↔GUI interop works.

- **Each window owns exactly one RuntimeSession.** `windowWillClose` calls
  `runtime.dispose()` (releases lock + kills pi). No orphan runtimes.

## Build & run

```bash
swift build                              # debug build
./bundle.sh debug && open build/pi.app   # bundle + launch
PISWIFT_SELFTEST=1 ./.build/debug/PiMac  # lock + parser self-test
```

## Code comments

- **Write all code comments in English.** Source comments are English-only
  across the repo. User-facing strings stay in the i18n layer (en + ko).

## Verify before declaring done

```bash
swift build                              # must be green
PISWIFT_SELFTEST=1 ./.build/debug/PiMac  # lock + parser tests pass
```

## Design principles

- Native macOS look (titlebar tabs, NavigationSplitView, system materials).
- Behavior parity with the web app; menus/layout can differ tastefully.
- HIG compliance: no critical actions at sidebar bottom, system accent colors
  for sidebar icons, disclosure controls for hierarchy.
- Subtle implicit animations on state/count changes (not flashy).
- Hover interactions on interactive elements.

## Remote architecture (future, designed)

```
iPhone/iPad (PiMobile) ──┐
                         ├─ direct LAN/P2P (fast)
                         ├─ self-host relay fallback (encrypted)
                         └─ APNs push ◄── PiPushGateway (developer-hosted)
                                          │
                                    Mac (PiMac, pi host)
```

- Relay is self-hosted by the user (Docker). E2E encrypted — relay can't read.
- Push gateway is developer-hosted (APNs key requirement). Stateless, sees only
  encrypted envelopes.
- `PiHost` protocol abstracts local/remote: PiMac uses `LocalPiHost` (spawn),
  PiMobile uses `RemotePiHost` (WebSocket). Same UI via PiUI.
