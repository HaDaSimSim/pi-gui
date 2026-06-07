// pi-gui preflight - whether pi is installed + required extensions are installed.
//
// pi-gui runs on top of pi's SDK/settings/extensions. If those are missing, it should
// guide "what to install" instead of showing a blank screen or a confusing error.
// All read-only file checks. No runtime/lock needed.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// pi's global settings directory. Same as the SDK default (~/.pi/agent).
function agentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
}

export interface PreflightCheck {
  id: string;
  ok: boolean;
  detail: string; // human-readable path/description (for UI display)
}

export interface PreflightResult {
  ok: boolean; // did everything pass
  checks: PreflightCheck[];
}

export function preflight(): PreflightResult {
  const dir = agentDir();
  const checks: PreflightCheck[] = [];

  // 1) Is pi installed/initialized - the ~/.pi/agent directory.
  checks.push({
    id: 'pi',
    ok: existsSync(dir),
    detail: dir,
  });

  // 2) Model config (auth or models). OK if either one exists.
  const hasAuth = existsSync(join(dir, 'auth.json'));
  const hasModels = existsSync(join(dir, 'models.json'));
  checks.push({
    id: 'models',
    ok: hasAuth || hasModels,
    detail: join(dir, 'models.json'),
  });

  // 3) session-lock extension - pi-gui's lock protocol must match this extension
  //    for conflict detection with the TUI/CLI to work. OK if index.ts is readable (symlink/copy doesn't matter).
  const lockExt = join(dir, 'extensions', 'session-lock', 'index.ts');
  checks.push({
    id: 'session-lock',
    ok: existsSync(lockExt),
    detail: lockExt,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
