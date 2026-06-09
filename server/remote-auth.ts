// Remote-control auth: Host-gated bearer token middleware.
//
// The backend keeps binding 127.0.0.1 only. `tailscale serve` terminates TLS on
// the tailnet and proxies to 127.0.0.1:<port>, so remote requests arrive on the
// same local socket — we tell them apart by the HOST HEADER, not the interface.
//
//   local Host (localhost/127.0.0.1)      → token exempt (existing browser/Tauri)
//   configured tailnet Host (*.ts.net)    → Bearer token REQUIRED
//   any other Host                        → rejected by the existing host guard
//
// See docs/remote-control-design.md §4.

import type { Context, MiddlewareHandler } from 'hono';
import type { RemoteStore } from './remote-config.ts';

// Hosts that are always local (the existing trust boundary). Port is ignored.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isLocalHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return LOCAL_HOST.test(host);
}

// Strip the optional :port from a Host header for comparison.
function hostName(host: string | undefined | null): string {
  if (!host) return '';
  return host.replace(/:\d+$/, '').toLowerCase();
}

// Does this Host match the configured tailnet host (while remote is active)?
export function isRemoteHost(store: RemoteStore, host: string | undefined | null): boolean {
  if (!store.isRemoteActive()) return false;
  const configured = store.tailnetHost();
  if (!configured) return false;
  return hostName(host) === hostName(configured);
}

// Whether a Host is allowed at all (local OR the active remote host). Callers use
// this to widen the existing DNS-rebinding host guard without opening it up.
export function isAllowedHost(store: RemoteStore, host: string | undefined | null): boolean {
  return isLocalHost(host) || isRemoteHost(store, host);
}

// Origin allowlist helper: local origins (any port) + the active remote origin.
const LOCAL_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
export function isAllowedOrigin(store: RemoteStore, origin: string | undefined | null): boolean {
  if (!origin) return true; // absent Origin (same-origin nav, Tauri internals)
  if (LOCAL_ORIGIN.test(origin)) return true;
  const configured = store.tailnetHost();
  if (store.isRemoteActive() && configured) {
    // The phone/web client served via tailscale serve uses https://<host>.
    if (origin.toLowerCase() === `https://${hostName(configured)}`) return true;
  }
  return false;
}

// ── Rate limit / lockout for bad bearer tokens ──────────────────────────────
// Simple in-memory counter keyed by remote host. After N failures within the
// window, reject for a cooldown to blunt brute force. Reset on success.
const MAX_FAILS = 10;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 5 * 60_000;

interface FailState {
  count: number;
  first: number;
  lockedUntil: number;
}
const fails = new Map<string, FailState>();

function lockedOut(key: string): boolean {
  const f = fails.get(key);
  return !!f && f.lockedUntil > Date.now();
}

function recordFail(key: string): void {
  const now = Date.now();
  const f = fails.get(key) ?? { count: 0, first: now, lockedUntil: 0 };
  if (now - f.first > WINDOW_MS) {
    f.count = 0;
    f.first = now;
  }
  f.count++;
  if (f.count >= MAX_FAILS) {
    f.lockedUntil = now + LOCKOUT_MS;
    f.count = 0;
    f.first = now;
  }
  fails.set(key, f);
}

function clearFail(key: string): void {
  fails.delete(key);
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

// Authenticate a request by Host. Returns:
//   'local'    → exempt (no token needed)
//   'ok'       → remote Host + valid token
//   'locked'   → remote Host but rate-limited
//   'denied'   → remote Host + missing/invalid token
//   'forbidden'→ Host not allowed at all (rebinding defense)
export type AuthVerdict = 'local' | 'ok' | 'locked' | 'denied' | 'forbidden';

export function authenticate(store: RemoteStore, c: Context): AuthVerdict {
  const host = c.req.header('host');
  if (isLocalHost(host)) return 'local';
  if (!isRemoteHost(store, host)) return 'forbidden';

  const key = hostName(host);
  if (lockedOut(key)) return 'locked';

  const token = bearer(c);
  if (!token) {
    recordFail(key);
    return 'denied';
  }
  const id = store.verifyToken(token);
  if (!id) {
    recordFail(key);
    return 'denied';
  }
  clearFail(key);
  return 'ok';
}

// Hono middleware: enforce auth on /api/* and let local through untouched.
// The pairing-confirm route is the one remote path allowed WITHOUT a prior
// active token (it carries a pending token instead), so callers can pass a
// predicate to treat it specially — but in practice confirm verifies the
// pending token itself, so we only exempt the *path* from active-token checks.
export function remoteAuthMiddleware(
  store: RemoteStore,
  opts?: { exemptPaths?: (path: string) => boolean },
): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    // Local Host is always exempt (existing browser/Tauri client).
    if (isLocalHost(host)) return next();
    // Host not allowed at all → DNS-rebinding defense.
    if (!isRemoteHost(store, host)) return c.json({ error: 'forbidden host' }, 403);
    // Remote Host on an exempt path (pairing-confirm): let the route verify its
    // own pending token; don't count it against the active-token lockout.
    if (opts?.exemptPaths?.(c.req.path)) return next();
    // Normal remote path: require a valid active bearer token.
    const verdict = authenticate(store, c);
    if (verdict === 'ok') return next();
    if (verdict === 'locked') return c.json({ error: 'too many attempts' }, 429);
    return c.json({ error: 'unauthorized' }, 401);
  };
}

// For tests: clear the in-memory lockout state.
export function _resetRateLimit(): void {
  fails.clear();
}
