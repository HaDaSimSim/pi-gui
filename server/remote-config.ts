// Remote-control token store + pairing state machine.
//
// SECURITY MODEL (see docs/remote-control-design.md §4–5):
//   - The plaintext token NEVER persists here. We store only a SHA-256 hash.
//     The plaintext exists once in the QR payload and on the phone (Keychain).
//   - A pairing starts as a "pending" device (with an expiry). The phone's first
//     authenticated call (`/api/remote/pair/confirm`) flips it to "active".
//   - Per-device entries → revoke one without touching the others.
//
// Config is stored under pi's agent dir (~/.pi/agent/pi-gui-remote.json) with
// 0600 perms. The owner string / on-disk identity stays "pi-web" elsewhere, but
// this file is pi-gui-only state (no pi TUI counterpart), so the name is fine.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Pending pairings expire after 5 minutes (short capture window for a leaked QR).
const PAIR_TTL_MS = 5 * 60 * 1000;

export type DeviceStatus = 'pending' | 'active';

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string; // SHA-256 of the plaintext token (hex)
  status: DeviceStatus;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number | null; // set while pending; null once active
}

export interface RemoteConfig {
  // Whether the user has turned remote on. Remote is only *active* when this is
  // true AND at least one active device exists (see isRemoteActive).
  enabled: boolean;
  // The configured tailnet host the proxy presents (e.g. mac.tailnet.ts.net).
  // null until pi-gui discovers/sets it. Used by the Host allowlist.
  tailnetHost: string | null;
  devices: DeviceRecord[];
}

function agentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
}

function configPath(): string {
  // PI_GUI_REMOTE_CONFIG lets tests point at a temp file.
  return process.env.PI_GUI_REMOTE_CONFIG?.trim() || join(agentDir(), 'pi-gui-remote.json');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Constant-time compare of two hex digests (defends against timing oracles).
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const EMPTY: RemoteConfig = { enabled: false, tailnetHost: null, devices: [] };

export class RemoteStore {
  private path: string;
  private config: RemoteConfig;

  constructor(path?: string) {
    this.path = path ?? configPath();
    this.config = this.load();
  }

  private load(): RemoteConfig {
    try {
      if (!existsSync(this.path)) return { ...EMPTY };
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<RemoteConfig>;
      return {
        enabled: !!raw.enabled,
        tailnetHost: raw.tailnetHost ?? null,
        devices: Array.isArray(raw.devices) ? (raw.devices as DeviceRecord[]) : [],
      };
    } catch {
      // A corrupt config must never crash the backend; fall back to closed.
      return { ...EMPTY };
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mode 0600: tokens-by-hash + host config are sensitive enough to keep
    // owner-only even though plaintext tokens are never written here.
    writeFileSync(this.path, JSON.stringify(this.config, null, 2), { mode: 0o600 });
  }

  // Drop expired pending pairings. Returns true if anything was removed.
  private sweepExpired(): boolean {
    const now = Date.now();
    const before = this.config.devices.length;
    this.config.devices = this.config.devices.filter(
      (d) => d.status === 'active' || (d.expiresAt ?? 0) > now,
    );
    return this.config.devices.length !== before;
  }

  // ── Public read API ────────────────────────────────────────────────

  getConfig(): RemoteConfig {
    if (this.sweepExpired()) this.save();
    return {
      enabled: this.config.enabled,
      tailnetHost: this.config.tailnetHost,
      devices: this.config.devices.map((d) => ({ ...d })),
    };
  }

  // Devices the UI shows (plaintext tokens never included anywhere).
  listDevices(): Omit<DeviceRecord, 'tokenHash'>[] {
    if (this.sweepExpired()) this.save();
    return this.config.devices.map(({ tokenHash: _omit, ...rest }) => ({ ...rest }));
  }

  // Remote is *active* (Host allowlisted, auth enforced) only when enabled AND
  // at least one active device exists. A token with no paired device stays shut.
  isRemoteActive(): boolean {
    if (this.sweepExpired()) this.save();
    return this.config.enabled && this.config.devices.some((d) => d.status === 'active');
  }

  tailnetHost(): string | null {
    return this.config.tailnetHost;
  }

  // ── Public write API ───────────────────────────────────────────────

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.save();
  }

  setTailnetHost(host: string | null): void {
    this.config.tailnetHost = host;
    this.save();
  }

  // Begin a pairing: create a pending device and return the plaintext token
  // ONCE (for the QR). The store keeps only the hash.
  pairInit(name: string): { id: string; token: string } {
    this.sweepExpired();
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.config.devices.push({
      id,
      name: name.trim() || 'device',
      tokenHash: sha256(token),
      status: 'pending',
      createdAt: now,
      lastSeenAt: null,
      expiresAt: now + PAIR_TTL_MS,
    });
    this.save();
    return { id, token };
  }

  // The phone's first authenticated call. Verifies the token against a *pending*
  // entry and flips it to active. Returns the device id on success, else null.
  confirmPairing(token: string): string | null {
    this.sweepExpired();
    const hash = sha256(token);
    const dev = this.config.devices.find(
      (d) => d.status === 'pending' && hashEquals(d.tokenHash, hash),
    );
    if (!dev) return null;
    dev.status = 'active';
    dev.expiresAt = null;
    dev.lastSeenAt = Date.now();
    this.save();
    return dev.id;
  }

  // Verify a bearer token against an ACTIVE device (the normal request path).
  // Returns the device id and bumps lastSeenAt, else null. lastSeenAt writes are
  // throttled to avoid a disk write on every single request.
  verifyToken(token: string): string | null {
    this.sweepExpired();
    const hash = sha256(token);
    const dev = this.config.devices.find(
      (d) => d.status === 'active' && hashEquals(d.tokenHash, hash),
    );
    if (!dev) return null;
    const now = Date.now();
    if (!dev.lastSeenAt || now - dev.lastSeenAt > 60_000) {
      dev.lastSeenAt = now;
      this.save();
    }
    return dev.id;
  }

  renameDevice(id: string, name: string): boolean {
    const dev = this.config.devices.find((d) => d.id === id);
    if (!dev) return false;
    dev.name = name.trim() || dev.name;
    this.save();
    return true;
  }

  // Revoke one device. Returns true if it existed.
  revokeDevice(id: string): boolean {
    const before = this.config.devices.length;
    this.config.devices = this.config.devices.filter((d) => d.id !== id);
    if (this.config.devices.length === before) return false;
    this.save();
    return true;
  }

  // Revoke all devices (rotate everything).
  revokeAll(): void {
    this.config.devices = [];
    this.save();
  }
}
