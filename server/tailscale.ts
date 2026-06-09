// Tailscale integration helpers for remote control.
//
// `tailscale serve` terminates TLS on the tailnet and proxies to a local port,
// so the backend keeps binding 127.0.0.1 only (no new listener). We shell out to
// the `tailscale` CLI; all calls are best-effort and fail soft (the feature is
// optional and the box may not have Tailscale).

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Discover the machine's MagicDNS name (e.g. "mac.tailnet.ts.net"), or null if
// tailscale isn't installed/running.
export function detectTailnetHost(): string | null {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const j = JSON.parse(out) as { Self?: { DNSName?: string } };
    const dns = j.Self?.DNSName?.replace(/\.$/, ''); // strip trailing dot
    return dns || null;
  } catch {
    return null;
  }
}

// Is the `tailscale` CLI available at all?
export function tailscaleAvailable(): boolean {
  try {
    execFileSync('tailscale', ['version'], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Start proxying the tailnet HTTPS endpoint to our local backend port.
//   tailscale serve --bg --https 443 http://127.0.0.1:<port>
// --bg keeps it running in the background (survives this process). Returns an
// error string on failure, or null on success.
export async function startServe(port: number): Promise<string | null> {
  try {
    await execFileP('tailscale', ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], {
      timeout: 8000,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Tear down the serve mapping on the HTTPS endpoint.
//   tailscale serve --https 443 off
export async function stopServe(): Promise<string | null> {
  try {
    await execFileP('tailscale', ['serve', '--https=443', 'off'], { timeout: 8000 });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
