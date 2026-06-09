# pi-gui Remote Control — Design (LAN/VPN edition)

Status: **proposal / not yet implemented**
Scope decision: **LAN/VPN-only transport** (no relay server), **iOS/iPadOS app in SwiftUI**.

Confirmed decisions (from review):
- Transport: **Tailscale-centric** (tailnet is the happy path; same-Wi-Fi plaintext
  is advanced / trusted-LAN-only).
- iOS/iPadOS target: **17+**.
- Distribution: **no App Store plans** for now (personal / sideload / TestFlight).
- iOS project lives **inside this repo** at `apps/ios/`.
- Backend lifecycle: **(A) tied to the pi-gui app lifetime** (window may be
  hidden; remote works while pi-gui runs; Cmd+Q ends it). launchd daemon is v2.
- System sleep: **documented limitation only** (Mac must be awake) — no power
  assertion in v1, matching Claude/Cowork's stated limitation.
- Locking: **no new lock for phone+desktop** — they share one backend (see §4.6).

This document is the agreed plan we write *before* touching code. It defines the
protocol, the security model, and the staged build order. Read `README.md` and
`AGENTS.md` first — the hard rules there constrain every decision here.

---

## 1. Background — what "remote" means elsewhere

We researched the two products the user referenced. They use the same word for
two genuinely different things:

### Pattern A — cloud execution
*Codex web (`developers.openai.com/codex/cloud`), Claude Code on the web.*
The agent runs in the **vendor's cloud container**, not your machine. You connect
a GitHub account; Codex works on tasks in the background (in parallel), and opens
PRs. No local clone needed, but **no access to your local filesystem, local MCP,
or local tools** — you configure a separate cloud environment.

### Pattern B — local session, remote control
*Claude Code "Remote Control" (`code.claude.com/docs/en/remote-control`).*
The agent **keeps running locally on your machine**. Phone/tablet/browser are
just a *window* into that local session. Key properties:

- The local session makes **outbound HTTPS only** and **never opens an inbound
  port**. It registers with the Anthropic API and polls for work; when a device
  connects, the API relays messages between the remote client and the local
  session over a streaming connection.
- Local environment (filesystem, MCP, project config) stays available; `@`
  autocompletes local paths.
- Conversation stays in sync across every connected surface (terminal / browser
  / phone) — you send from any of them interchangeably.
- Survives laptop sleep / network drops; reconnects when the machine is back.
- Connect via claude.ai/code, or the iOS/Android app (QR code to open directly).

### Which one is pi-gui?

pi-gui is already **Pattern B, but LAN-only**:

| pi-gui today | Claude Remote Control |
|---|---|
| Backend on `127.0.0.1`, runs pi SDK runtime locally | Local session runs locally |
| Browser is a window into the local session over SSE/WS | Web/mobile is a window into the local session |
| `session-lock` = one writer per session | (one session per machine) |

The only missing piece is **a safe path to reach the backend from a device that
is not on `localhost`** — i.e. a phone. Claude solves this with an outbound
relay through their own API. pi-gui has no such API, so per the user's choice we
take the simplest safe path that does **not** require us to host a relay:
**reach the backend over a trusted private network (LAN or a VPN such as
Tailscale/WireGuard).**

---

## 2. The constraint we must not break

From `AGENTS.md` (load-bearing):

> **Backend binds to `127.0.0.1` only.** Never change the bind host or add a
> network listener without adding auth in the same change. This process has full
> local shell/file/model-key access via pi's SDK.

And the trust boundary in `server/index.ts`:

- bind `hostname: '127.0.0.1'`
- Host-header guard: `^(localhost|127\.0\.0\.1)(:\d+)?$` (DNS-rebinding defense)
- Origin whitelist: `tauri://localhost` + `localhost`/`127.0.0.1` any port
- WS upgrade reuses the same origin check

LAN/VPN exposure means **all four of these change at once**, and that change is
only allowed if **authentication ships in the same change**. This document
treats auth as a non-negotiable part of step 1, not a follow-up.

### 2.1 Lifecycle reality (from the code)

From `src-tauri/src/lib.rs` + `runtime-manager.ts`:
- Tauri spawns the backend as a child on launch, kills it on `ExitRequested`.
- Closing the window **hides to background** (does not quit); the backend keeps
  running. Real quit is Cmd+Q / dock→Quit only.
- A parent-death watchdog makes the backend self-exit if Tauri dies.
- `RuntimeManager` reaps idle runtimes after 5 min (read paths need no runtime,
  so scrollback/lists survive; sending re-spawns).

Consequence for remote: per decision (A), **remote control is available exactly
while pi-gui is running** (window may be hidden). This matches Claude Remote
Control's model and needs no new daemon. Cmd+Q closes the remote binding too.

System sleep: a phone can reach the Mac only while the Mac is **awake**. The
display may be off (energy saver) — only full *system sleep* stops the backend
and drops the tailnet connection. v1 documents this as a known limitation (no
power assertion). v2 may add an opt-in `PreventUserIdleSystemSleep` assertion.

Other load-bearing rules that shape the design:

- **Browsing must never spawn a runtime.** The remote transport must reuse the
  exact same route handlers, so `/api/directories`, `/api/sessions`,
  `/api/session*` (reads) stay runtime-free; only `prompt`/`open`/`new` + control
  routes touch a runtime + lock.
- **The lock guard is load-bearing.** Remote prompts go through the *same*
  `RuntimeManager.prompt()` path. The transport never bypasses the lock.
- We do **not** watch another process's writes (out of scope). Remote control
  only streams runtimes pi-gui owns — unchanged.

---

## 3. Architecture

```
┌─────────────────────────┐         private network (LAN or VPN)
│  iOS / iPadOS app        │   WSS/HTTPS over Tailscale/WireGuard/same-Wi-Fi
│  (SwiftUI)               │ ─────────────────────────────────────────────┐
└─────────────────────────┘                                               │
                                                                          ▼
                                              ┌──────────────────────────────────────┐
                                              │ pi-gui backend (Hono, Node)            │
                                              │                                        │
                                              │  bind: 127.0.0.1  (default, unchanged) │
                                              │  bind: <LAN/VPN iface>  (opt-in only,  │
                                              │        gated behind PI_GUI_REMOTE=1    │
                                              │        AND a configured auth token)    │
                                              │                                        │
                                              │  NEW: auth middleware (bearer token)   │
                                              │  NEW: relaxed Host/Origin allowlist    │
                                              │       for the configured remote host   │
                                              │                                        │
                                              │  REUSED unchanged:                     │
                                              │   • all /api/* route handlers          │
                                              │   • /ws subscription + SSE             │
                                              │   • RuntimeManager + session-lock      │
                                              └──────────────────────────────────────┘
```

No relay server. No new cloud component. The phone reaches the same Hono server
the browser already talks to — just over a private network address instead of
`localhost`, and only when the user explicitly turns it on and pairs a device.

### Why this respects the cost model

The iOS app is a second client of the *existing* REST + WS API. It calls the
same handlers, so:
- listing/reading stays runtime-free (Pattern B browsing is still free);
- sending/opening/controlling goes through `RuntimeManager` + the lock, exactly
  like the browser.

The app is a thin mirror of `web/` — nothing about agent behavior moves into it.

---

## 4. Security model (ships in step 1 with the bind change)

Exposing beyond `127.0.0.1` is RCE-level risk — this backend has full local
shell/file/model-key access. Auth is therefore **the condition for opening the
bind**, not an add-on. Defense in depth, two layers:

### 4.0 Threat model

When remote is on, the backend also binds the tailnet interface (`100.x`). That
means **any node in the tailnet** can reach the port (including other people if
the tailnet is shared). We do not trust the network alone; per-device tokens are
the real gate.

### Layer 1 — Tailscale (free foundation, confirmed `tailscale serve`)

- Outside the tailnet the port is **physically unreachable** (zero public exposure).
- Behind **`tailscale serve`** we get a **trusted TLS cert automatically**, so the
  iOS app needs **no cert pinning**. This is the chosen TLS path (see §4.5).
- Not sufficient alone: other tailnet nodes still pass through. Hence layer 2.

> **Key implementation consequence (no bind change!).** `tailscale serve`
> terminates TLS on the tailnet and **proxies to `127.0.0.1:<port>`**. So the
> backend **keeps binding `127.0.0.1` only** — we open **no new listener**, which
> means the load-bearing AGENTS rule ("backend binds to 127.0.0.1 only") is
> **untouched**. Remote requests arrive on the same local socket; we tell them
> apart by the **Host header** the proxy sets (`<machine>.<tailnet>.ts.net`),
> not by the socket interface. Auth therefore gates on Host, not on bind address.

### Layer 2 — per-device bearer token (the actual auth, token-only by decision)

- Each paired device gets an **independent random token** (`crypto.randomBytes(32)`
  → base64url).
- The backend stores **only the hash** (SHA-256). Plaintext goes to the phone
  once via QR and is never persisted server-side — a leaked config file does not
  reveal usable tokens.
- Stored in pi-gui's config dir, file perms `0600`. Each entry:
  `{ id, name, tokenHash, createdAt, lastSeenAt }` → per-device revoke.
- We do **not** also check Tailscale identity headers (token-only keeps LAN mode
  possible and the middleware simple).

Mitigations, all required:

1. **Off by default.** Remote is active only when **all three** hold:
   `PI_GUI_REMOTE=1` (or a UI toggle that sets it), a non-empty auth token, and
   **at least one paired device**. If any is missing, no remote Host is
   allowlisted, so even if `tailscale serve` is running every proxied request is
   rejected at the Host guard. (Stricter than "toggle + token": a token with no
   paired device still keeps remote closed.)

2. **No new bind / no `0.0.0.0`.** The backend keeps binding `127.0.0.1` only.
   `tailscale serve` terminates TLS on the tailnet and proxies to
   `127.0.0.1:<port>`, so there is **no second listener** and the AGENTS bind
   rule is untouched. (A future non-Tailscale LAN mode would need an explicit
   second bind + its own auth review; out of scope for v1.)

3. **Bearer-token auth, gated by Host header.** A new middleware sits **right
   after the existing Host/Origin guard** and decides by the request **Host**
   (not socket interface, since everything arrives on `127.0.0.1`):
   - **local Host** (`localhost`/`127.0.0.1`) → token **exempt** (the existing
     browser/Tauri client changes by 0 bytes).
   - **configured tailnet Host** (`<machine>.<tailnet>.ts.net`) →
     `Authorization: Bearer <token>` **required**; matched against stored
     `tokenHash` with a **timing-safe** compare; on success bump `lastSeenAt`;
     on failure 401 + increment the lockout counter (mitigation 6).
   - **any other Host** → 403 (the existing DNS-rebinding defense, unchanged).
   - **WS upgrade** is checked the same way. iOS `URLSessionWebSocketTask` can set
     the `Authorization` header, so we authenticate the upgrade with Bearer too
     — **no token in the query string** (avoids it leaking into logs).

4. **Host/Origin allowlist extended, not removed.** The current
   `127.0.0.1|localhost` allowlist is widened to also accept the configured
   tailnet host (`<machine>.<tailnet>.ts.net`) — and *only* that one, and only
   while remote is active (mitigation 1). The DNS-rebinding defense stays: an
   unknown Host is still 403.

4. **Host/Origin allowlist extended, not removed.** The current
   `127.0.0.1|localhost` allowlist is widened to also accept the configured
   tailnet host (`<machine>.<tailnet>.ts.net`) — and *only* that one. The
   DNS-rebinding defense stays: an unknown Host is still 403.

5. **TLS via `tailscale serve` (confirmed).** Run the backend behind
   `tailscale serve` so all remote traffic is TLS with a **trusted cert** — the
   iOS app does no cert pinning. pi-gui can automate the `tailscale serve` setup
   when remote is enabled (detect the `tailscale` CLI, wire the serve mapping to
   the backend port). Self-signed + fingerprint pinning is **not** used in v1.
   Plain `http`/`ws` to a tailnet IP is only a documented fallback for users
   without `serve`, flagged as trusted-network-only.

6. **Rate-limit + lockout** on auth failures to blunt token brute force.

7. **Pairing is revocable.** Each paired device gets its own token entry;
   revoking one in the pi-gui UI invalidates just that device. Removing the last
   paired device closes the remote bind (per mitigation 1).

8. **Auto-close on quit / tailnet loss.** Cmd+Q (real quit) tears down the
   remote binding. If the tailnet interface disappears, the remote listener is
   dropped and falls back to `127.0.0.1`-only.

### 4.6 Locking: no new lock for phone + desktop

The phone and the desktop/web UI both connect to **one pi-gui backend process**.
They share the same `RuntimeManager`; a send from either goes through the same
`RuntimeManager.prompt()` and the same per-runtime queue/streaming state, so
writes are **already serialized** without any new lock. The phone is just
another WS/REST client, not a second writer process.

`session-lock` stays load-bearing for its real job: blocking a *different*
process (the pi TUI, or a second pi-gui instance) from writing the same session
file. We do **not** add a phone-vs-desktop lock.

The only cross-device concern is UX when a session is already streaming and a
second device sends: this reuses the existing behavior (`/api/session/queue` /
the current streaming guard). The phone inherits that as-is — no new policy.

> Summary of the AGENTS rule compliance: the bind host only changes **together
> with** per-device token auth + an extended-but-still-closed Host/Origin
> allowlist + `tailscale serve` TLS. That is the "auth in the same change"
> requirement, satisfied.

### 4.7 Why this auth design (alternatives considered)

- **mTLS / client certs:** strongest, but heavy to provision + manage in the iOS
  Keychain, and overkill for a no-App-Store personal tool. Rejected.
- **OAuth / account login:** pi-gui has no account concept and no server.
  Inapplicable.
- **Tailscale identity only:** lets *any* tailnet node through and doesn't cover
  a non-Tailscale LAN. Insufficient alone.
- **per-device bearer + `tailscale serve` TLS (chosen):** lightweight,
  per-device revoke, zero impact on localhost clients, no iOS cert pinning.

---

## 5. Pairing system (QR, one-shot, hash-only)

Design goal: **plaintext token never persists on the backend; the QR is
single-use and short-lived.** Pairing is a small state machine.

### 5.1 State flow

```
[desktop]  "Add device" clicked
   │
   ├─ backend: generate deviceId + token (randomBytes(32) → base64url)
   │           store ONLY { id, tokenHash, status: "pending", expiresAt: now+5m }
   │           keep plaintext token in MEMORY only (for the QR)
   │
   ├─ QR shown: { v:1, url, token, deviceId }   + 5-min countdown + "New code"
   │
[phone]  scans QR
   │
   ├─ phone: store token in iOS Keychain
   │         GET /api/remote/pair/confirm   (Authorization: Bearer <token>)  ← first authed call
   │
   ├─ backend: match tokenHash AND status==pending AND not expired
   │           → status: "active", set name, bump lastSeenAt
   │           → discard the in-memory plaintext
   │
[desktop]  tray + settings show "iPhone connected ✓" (WS push)
```

### 5.2 Why this shape

- Plaintext token exists only in the QR and the phone's Keychain. The backend
  keeps **only the SHA-256 hash** — a leaked config file yields no usable token.
- 5-minute expiry → a captured/leaked QR has a short window. Expired `pending`
  entries are swept automatically.
- `confirm` *is* the phone's first Bearer-authenticated request, so it proves the
  token actually reached the device before we flip the entry to `active`. An
  unscanned QR simply expires.
- Per-device token → losing one device revokes only that token.

### 5.3 Device management (settings + tray)

- List: name, last-seen time, online dot (WS connected?), revoke button.
- Revoke = delete the hash entry → next request from that device is 401.
  Deleting the last device closes the remote bind (§4 mitigation 1).
- Actions: rename, "revoke all" (rotate every token).

### 5.4 Pairing endpoints

| Endpoint | Origin | Purpose |
|---|---|---|
| `POST /api/remote/devices/pair-init` | localhost only | create pending entry, return QR payload |
| `GET  /api/remote/pair/confirm` | tailnet, Bearer | phone's first call; flip pending→active |
| `GET  /api/remote/devices` | localhost only | list devices + online state |
| `PATCH /api/remote/devices/:id` | localhost only | rename |
| `DELETE /api/remote/devices/:id` | localhost only | revoke one (or all) |

All management is localhost-only (you configure remote from the trusted desktop
UI); the phone only ever calls `confirm` + the normal `/api/*` + `/ws`.

This mirrors Claude's QR-to-phone UX while keeping secrets inside the tailnet.

---

## 5A. macOS tray (menu-bar status item)

Today there is **no tray** — only the top menu bar (App/Edit/View/Window/Help).
The tray is added with `tauri::tray::TrayIconBuilder` and doubles as the
remote-control panel, so a hidden window still exposes full control. It is built
**independent of remote** (ships first); the remote/streaming status dots wire in
later.

### 5A.1 Icon states (shape/badge, no text)

- idle: monochrome π
- remote ON + a device connected: π + green dot
- a session streaming (turn in progress): π + pulse / count badge

### 5A.2 Dropdown menu

```
● Remote Control: On            ← toggle (off closes the bind)
  Connected: iPhone, iPad
  ──────────────
  Active sessions: 2 streaming   ← click focuses the window on that session
    ▸ pi-gui — "fix auth bug"
    ▸ blog   — "draft post"
  ──────────────
  Show pi-gui                    ← re-show the hidden window
  Add device…                    ← open the QR pairing dialog
  ──────────────
  Backend: :51763 ✓              ← port / health (click → log)
  Quit pi-gui
```

### 5A.3 How it updates

The frontend already knows live/streaming state and (later) remote/device state.
It pushes a snapshot to Rust via a new `set_tray_state` command (mirroring the
existing `set_busy`); Rust rebuilds the dynamic portion of the menu and swaps the
icon. Observation-only, no polling. Menu clicks emit events the frontend handles
(focus a session, open pairing dialog, toggle remote) or Rust handles directly
(show window, quit).

---

## 6. iOS / iPadOS app (SwiftUI)

A native mirror of the screens `web/` already renders. It is a **client of the
existing API** — it does not embed pi or duplicate agent logic.

### Screens (mapped to existing web components)

| iOS screen | Mirrors | Backend calls |
|---|---|---|
| Directories list | `sidebar.tsx` | `GET /api/directories` |
| Sessions list (per dir) | `sidebar.tsx` | `GET /api/sessions?cwd=` |
| Chat / scrollback | `message-view.tsx` + `session-tab.tsx` | `GET /api/session`, `WS /ws` subscribe |
| Composer (send) | `session-tab.tsx` editor | `POST /api/session/prompt` |
| Slash commands | `model-controls.tsx`/commands | `GET /api/session/commands` |
| Model / thinking | `model-controls.tsx` | `POST /api/session/model`,`/thinking` |
| Abort / queue | controls | `POST /api/session/abort`,`/queue` |
| Todo widget | `todo-widget.tsx` | from `gui-state` events on WS |
| Subagent runs | `subagent-run.tsx` / `subagent-chat-view.tsx` | session entries + WS |
| UI requests (confirm/select/input/questionnaire/btw) | `ui-request-dialog.tsx`, `questionnaire-dialog.tsx` | WS event → `POST /api/session/ui-response` |
| Git panel | `git-panel.tsx` | `GET /api/git`, `/api/git/commit` |
| Footer (tokens/cost) | `footer.tsx` | `GET /api/session/footer` |

### Tech choices

- **SwiftUI**, iOS 17+/iPadOS 17+ (target a current baseline; confirm with user).
- **URLSession** for REST; **URLSessionWebSocketTask** for `/ws` (subscribe by
  path, receive `{ path, event }` frames — same shape the web bus consumes).
- Reuse the WS message contract exactly: client sends
  `{ type: "subscribe", paths: [...] }`, server streams `{ path, event }`.
- Keychain for the token; pinned cert in `URLSessionDelegate`.
- Markdown rendering for assistant messages (swift-markdown or a lightweight
  renderer) to match `markdown.tsx`.
- Keep IME/last-char parity in mind for the composer (the web has a known
  Korean/IME guard; native iOS text input is fine, but test Korean input).

### Out of scope for the app

- No local shell, no file editing on the device — it is a control surface.
- No agent/tool/policy logic (that lives in pi-skills, per scope discipline).

---

## 7. Protocol contract (what the app codes against)

The app targets the **already-existing** REST + WS surface. No new endpoints are
required for core chat; only the auth header and the pairing/devices endpoints
are new.

New endpoints (step 1):
- `POST /api/remote/enable` → generates token, returns `{ url, token, fingerprint }`.
- `POST /api/remote/disable` → unbinds remote, keeps `127.0.0.1`.
- `GET /api/remote/devices` / `DELETE /api/remote/devices/:id` → list/revoke.
- (All of these are localhost-only; you configure remote *from* the trusted
  desktop/web UI.)

Existing endpoints (unchanged behavior, now also reachable with a bearer token):
everything under `/api/*` and `/ws` as listed in §6.

---

## 8. Staged build order

Each stage is independently shippable and verifiable.

**Stage 0 — design (this document).** ✅ when approved.

**Stage 1 — backend remote module + auth.**
- Token store in config; `POST /api/remote/enable|disable`, devices list/revoke.
- Auth middleware: require bearer for non-localhost; localhost stays token-free.
- Bind logic: opt-in second bind (LAN/VPN iface) behind `PI_GUI_REMOTE=1` + token.
- Extend Host/Origin allowlist to the configured remote host only.
- TLS path (Tailscale cert documented; self-signed + fingerprint fallback).
- Verify: `pnpm typecheck`, `pnpm test:unit`, plus new unit tests for the auth
  middleware (localhost bypass, bearer required off-localhost, bad token 401,
  unknown Host still 403). E2E with the `PORT=4318 PI_GUI_NO_PARENT_WATCH=1`
  pattern from AGENTS.md.

**Stage 2 — desktop/web pairing UI.**
- Settings panel: enable/disable toggle, QR code, paired-devices list + revoke.
- i18n: add keys to `web/i18n.ts` (en source of truth, mirror in ko; owner-style
  labels can stay English per the i18n rule). Verify en/ko parity.

**Stage 3 — SwiftUI app skeleton.**
- New `apps/ios/` (Xcode project). QR pairing → store token/cert.
- API client (REST + WS), directories → sessions → chat read-only first.
- Verify against a LAN backend (`PORT=4318` pattern), then Tailscale.

**Stage 4 — SwiftUI interactivity.**
- Composer/send, model/thinking, abort/queue, slash commands.
- UI-request dialogs (confirm/select/input/questionnaire/btw), todo + subagent
  views. Each maps 1:1 to an existing web component for parity.

**Stage 5 — hardening.**
- Reconnect/resume after sleep/network drop (mirror Claude's resilience).
- Rate-limit/lockout, token rotation, audit of the trust boundary.

---

## 9. Resolved decisions

All initial open questions are answered (see header):
1. **Transport default:** Tailscale is the documented happy path; same-Wi-Fi
   plaintext is advanced / trusted-LAN-only.
2. **iOS/iPadOS target:** 17+.
3. **Distribution:** no App Store plans now — personal / sideload / TestFlight.
4. **Repo layout:** `apps/ios/` inside this repo (keeps the API contract in lockstep).
5. **Backend lifetime:** tied to the pi-gui app (window may be hidden); launchd
   daemon deferred to v2.
6. **System sleep:** documented limitation only in v1 (no power assertion).
7. **Locking:** no phone-vs-desktop lock (shared backend); `session-lock`
   unchanged for cross-process safety.

### Remaining items to settle during Stage 1

- Exact config location for the token + paired-device list (reuse pi-gui's
  existing config store vs a new file). Must not be world-readable.
- Tailscale HTTPS specifics: `tailscale cert` vs serving behind `tailscale serve`
  — decide which gives the cleanest trusted-cert path for iOS.
- Token format + rotation policy (per-device secret; rotation on revoke-all).
