# pi-gui

A native macOS GUI for [pi](https://github.com/earendil-works/pi) — browse and
chat across **multiple directories and sessions at once** with native titlebar
tabs, each session running its own `pi --mode rpc` process.

## What it does

- **Native macOS app** — SwiftUI + AppKit, Ghostty-style titlebar tabs, system
  materials, NavigationSplitView sidebar.
- **Multi-session** — each tab is a real NSWindow holding one pi runtime + an
  exclusive session lock. Open as many as you want; the OS manages tab grouping.
- **Full feature parity** with the pi TUI: streaming chat, tool execution,
  subagents, slash commands, extension UI (confirm/select/input/questionnaire),
  git panel, model/thinking controls.
- **Lock interop** — uses the same lock protocol as the TUI (`owner="pi-web"`).
  Only one writer per session; the GUI and TUI respect each other's locks.

## Build & run

Requires: macOS 14+, Swift 6.0+ toolchain, Node.js (for the pi binary).

```bash
swift build
./bundle.sh debug && open build/pi.app
```

Or run directly from the build:
```bash
.build/debug/PiMac
```

## Project structure

```
pi-gui/
├── Package.swift
├── Sources/
│   ├── PiCore/          # Cross-platform models, protocols, parsing (Linux-safe)
│   ├── PiUI/            # Shared SwiftUI views (macOS + iOS)
│   ├── PiMac/           # macOS host app (spawns pi, holds lock)
│   ├── PiMobile/        # iOS remote client (stub)
│   ├── PiRelay/         # Self-host relay server (stub)
│   └── PiPushGateway/   # APNs push gateway (stub)
├── Resources/           # AppIcon.icns
├── bundle.sh            # Package into pi.app bundle
└── dmg.sh              # Create distributable DMG
```

## Architecture

Each open session = one NSWindow in a native tab group, owning:
- A `RuntimeSession` (RPC client → pi process + session lock)
- A SwiftUI view tree (sidebar + chat + info panel)

The app never writes to a session file directly — all writes go through pi's
RPC protocol. The session lock ensures mutual exclusion with the TUI.

```
┌─────────────────────────────────┐
│ NSWindow (native titlebar tab)  │
│ ┌─────────┐ ┌────────────────┐ │
│ │ Sidebar │ │ Session chat   │ │
│ │ (browse)│ │ + info panel   │ │
│ └─────────┘ └────────────────┘ │
│       ↕ RPC (stdin/stdout)      │
│   pi --mode rpc (child process) │
│       ↕ session.jsonl           │
└─────────────────────────────────┘
```

## Remote (planned)

The app is designed for a future iOS/iPadOS remote client:
- **PiMobile** connects to the Mac's pi host via LAN direct or a self-hosted
  relay server (E2E encrypted).
- **PiPushGateway** (developer-hosted) delivers APNs notifications when a turn
  finishes or an extension needs input.
- Shared `PiCore` types + `PiUI` views are reused across platforms.

## License

MIT — see [LICENSE](LICENSE).
