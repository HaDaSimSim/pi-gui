# pi for iOS / iPadOS

A native SwiftUI client for [pi-gui](../../README.md). It is a **remote control
surface** for a pi-gui backend running on your Mac — it does not embed pi or run
any agent logic itself. Everything it shows comes from the same REST + WebSocket
API the web UI uses.

See `../../docs/remote-control-design.md` for the full architecture and security
model.

## How it connects

```
iPhone/iPad (this app)
   │  HTTPS + WSS, Authorization: Bearer <per-device token>
   ▼
tailscale serve  (TLS termination on the tailnet)
   ▼
pi-gui backend  (127.0.0.1 only — never binds a public port)
```

The Mac keeps binding `127.0.0.1`. `tailscale serve` proxies the tailnet HTTPS
endpoint to that local port, so the app reaches the backend over your tailnet
with a trusted cert (no cert pinning). Auth is a **per-device bearer token**
issued during QR pairing; the backend stores only its hash.

## Pairing

1. On the Mac: pi-gui → Settings → Remote Control → enable, then **Add device**.
2. The desktop shows a QR code (`{ v, url, token, deviceId }`, 5-min expiry).
3. In this app: **Scan QR Code**. The app stores the token in the Keychain and
   calls `/api/remote/pair/confirm` to activate the device.

## What's implemented

Mirrors the pi-gui desktop feature set:

- **Browse** directories → sessions (live dot, message counts), pull-to-refresh.
- **Chat**: full scrollback from session entries, live streaming over the
  multiplexed WebSocket (text, thinking, tool calls, subagent runs, user bash).
- **Compose**: send, follow-up while streaming, abort.
- **Controls**: model picker, thinking level, rename.
- **Slash commands** palette.
- **Git** panel (branch, staged/changed/untracked, recent commits).
- **Above-composer widgets**: todo list, goal status, queued messages.
- **UI bridge dialogs**: confirm / select / input / editor / questionnaire / btw.
- **Lock conflict** handling with take-over.
- Settings + unpair.

## Build

Requires Xcode 16+, an iOS 17+ simulator or device, and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
cd apps/ios
xcodegen generate          # writes PiGui.xcodeproj from project.yml
open PiGui.xcodeproj        # then run on a simulator/device
```

Or build from the CLI:

```bash
xcodebuild -project PiGui.xcodeproj -scheme PiGui \
  -sdk iphonesimulator -destination 'name=iPhone 16' build
```

`PiGui.xcodeproj` is generated — edit `project.yml` and re-run `xcodegen`, not
the pbxproj. To run on a physical device, set `DEVELOPMENT_TEAM` in `project.yml`
(or in Xcode's Signing & Capabilities).

## Scope

This app is host + UI only, same discipline as pi-gui: agent behavior, tools,
and per-session policy live in pi-skills extensions, never here.
