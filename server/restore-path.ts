// Restore the user's real login-shell PATH for GUI-launched backends.
//
// Why this exists: when pi-gui runs as a bundled macOS .app, the OS (launchd)
// starts it with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`, plus whatever
// pi core prepends). The user's interactive shell PATH — the one that includes
// version managers like nvm/fnm/asdf, Homebrew, pyenv, ~/.local/bin, etc. — is
// only assembled by their shell rc files (.zshrc/.bash_profile) and is NOT
// inherited by a Finder/Dock launch. As a result, child processes the backend
// spawns (the `pi` CLI for subagents, anything the bash tool runs) can't find
// binaries the user clearly has on their PATH in a terminal, failing with ENOENT.
//
// In a `pnpm dev` launch the backend already inherits the terminal's full PATH,
// so this is a no-op there. It only does real work for GUI launches with a
// stunted PATH.
//
// Approach: ask the user's login shell to print its PATH, then merge those
// entries into process.env.PATH (shell entries first so they take precedence,
// matching what the user gets in a terminal), deduped. This fixes every child
// process at once, not just subagent spawning.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

// Sentinels bracket the PATH so we can extract it even if the shell's rc files
// print banners/noise to stdout.
const BEGIN = '__PI_GUI_PATH_BEGIN__';
const END = '__PI_GUI_PATH_END__';

function detectLoginShell(): string {
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) return shell;
  // Reasonable default on macOS (zsh) / most Linux (bash).
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

// Query the login shell for its PATH. Returns the PATH string or null on failure.
function queryLoginShellPath(): string | null {
  const shell = detectLoginShell();
  // -i (interactive) + -l (login) makes the shell source the same rc files a
  // terminal would, so version-manager PATH edits are applied. printf avoids a
  // trailing newline inside the sentinels.
  const script = `printf '%s%s%s' '${BEGIN}' "$PATH" '${END}'`;
  try {
    const out = execFileSync(shell, ['-ilc', script], {
      encoding: 'utf-8',
      timeout: 5000,
      // Don't let the probe inherit our stdin; some rc files misbehave otherwise.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const start = out.indexOf(BEGIN);
    const stop = out.indexOf(END);
    if (start === -1 || stop === -1 || stop < start) return null;
    const path = out.slice(start + BEGIN.length, stop);
    return path.trim() ? path : null;
  } catch {
    // Shell missing, timed out, or non-zero exit: keep the inherited PATH.
    return null;
  }
}

// Merge restored entries into process.env.PATH, restored entries first (terminal
// precedence), existing entries appended, deduped. Idempotent.
function mergeIntoEnv(restored: string): void {
  const sep = ':';
  const current = (process.env.PATH ?? '').split(sep).filter(Boolean);
  const incoming = restored.split(sep).filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...incoming, ...current]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  process.env.PATH = merged.join(sep);
}

// Restore the user's login-shell PATH into process.env.PATH. Safe to call once
// at boot. No-op on Windows and when opted out via PI_GUI_NO_PATH_RESTORE.
export function restoreLoginShellPath(): void {
  if (platform() === 'win32') return;
  if (process.env.PI_GUI_NO_PATH_RESTORE) return;
  const restored = queryLoginShellPath();
  if (restored) mergeIntoEnv(restored);
}
