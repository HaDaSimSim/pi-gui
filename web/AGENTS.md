# AGENTS.md — web/ (frontend)

Frontend-specific invariants. The repo-wide rules (backend `127.0.0.1`-only, the
session lock guard, browsing-never-spawns-a-runtime, the UI bridge, the
`shared/session-lock.ts` symlink, the `"pi-web"` owner identity) live in the
**root `AGENTS.md`** — read that first. This file only covers `web/`.

See `web/README.md` for the component map and data flow.

## Load-bearing invariants

- **`@/` aliases `web/` and must stay in sync in two files.** It's set in both
  `vite.config.ts` (`alias`) and `tsconfig.json` (`paths`). Change one, change
  the other, or builds and type-checks disagree.

- **Single multiplexed WebSocket — don't reintroduce per-tab SSE.** All
  per-session events go through the one socket in `event-bus.ts`
  (`subscribeEvents` in `api.ts` delegates to it). The browser's 6-connection
  HTTP/1.1 cap is the reason; a permanent EventSource per tab starves `fetch`
  once enough tabs are open. Keep all tabs subscribed.

- **Route every `fetch`/`EventSource`/WebSocket URL through `config.ts`.** Use
  `apiUrl()` for REST and `wsUrl()` for sockets. A hardcoded relative or
  absolute URL works in the browser but breaks the Tauri prod build, where the
  backend is on a dynamic injected port (`window.__PI_GUI_PORT__`). New
  network-dependent UI that runs before the port arrives must also wait on
  `waitForBackendPort()` (see `PreflightGate`).

- **The Textarea IME guard is load-bearing.** In `session-tab.tsx`'s composer
  `onKeyDown`, the very first check is
  `if (e.nativeEvent.isComposing || e.keyCode === 229) return;` before any
  Enter-to-send handling. Removing it makes Korean/IME composition lose the last
  character on Enter. Don't reorder it after the Enter handling either.

- **The shadcn ScrollArea viewport override is intentional.** Radix wraps
  content in a `display:table` div that breaks `truncate` and overflows; the
  `[&>div]:!block [&>div]:!w-full [&>div]:min-w-0` override in
  `components/ui/scroll-area.tsx` fixes it. Don't revert it.

- **`react-resizable-panels` here is v4.** Use `Group`/`Panel`/`Separator`,
  `usePanelRef`, and `orientation` (not `direction`); there's no
  `onCollapse`/`autoSaveId`. The shadcn wrapper names
  (`ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`) are aliases in
  `components/ui/resizable.tsx`. Collapse/expand is driven imperatively via the
  panel ref (`p.collapse()` / `p.expand()` / `p.isCollapsed()`).

- **Theme is the `<html>` class, not a JS theming API.** `use-ui-settings.ts`
  toggles `.dark` and `.dark.true-dark` on `document.documentElement` and sets
  `--piweb-font-*` CSS variables; the true-dark (OLED) tokens are Tailwind
  overrides in `globals.css`. Settings persist to `localStorage` and are applied
  at module load so the theme is correct before first paint.

## Mirroring discipline

The frontend only renders what extensions and the GUI-state bridge leave behind;
it never drives agent behavior. When parsing foreign session entries, **keep the
shape guards.** pi has no per-extension namespace, so `customType` is a global
flat namespace — `entriesToMessages()` checks the producer's signature
(`data.runId: string` for `subagent-run`, `details.elapsed: number` for
`turn-meta`) and ignores entries that don't match, so a third party reusing the
same type with a different shape can't crash the render. Add the same kind of
guard for any new custom-entry renderer. Agent behavior belongs in pi-skills
extensions, not here (see root `AGENTS.md` scope discipline).

## i18n

`web/i18n.ts` is a flat dict; **`en` is the source of truth and `ko` must mirror
its key set exactly.** After touching it, run `pnpm test:unit` — the i18n test
parses both blocks and fails on any key-set mismatch. Lock/settings owner labels
are intentionally English-only (not i18n'd).

## Comments

All code comments are **English only**, repo-wide. User-facing strings go in
`i18n.ts` (en + ko); comments do not. Don't reintroduce non-English comments
(some legacy comments in `i18n.ts` are Korean — leave the dict working, but
write new comments in English).

## Verify before declaring done

```bash
pnpm typecheck   # tsc --noEmit — vite build does NOT type-check
pnpm build:web   # vite build
pnpm test:unit   # lock units + i18n en/ko parity
```
