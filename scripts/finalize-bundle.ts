// Build post-processing — does two things.
//
// 1) Remove spaces from the dmg filename. Tauri embeds productName("π (pi)")
//    verbatim into the filename, producing "π (pi)_<ver>_<arch>.dmg". We leave
//    the app bundle/executable name (branding) as-is and only rename the
//    distributed dmg to "pi-gui_<ver>_<arch>.dmg". (Tauri v2 has no dmg-specific
//    filename option, so we do it in post-processing.)
//
// 2) Verify the single version source. package.json is the source of truth.
//    tauri.conf.json points at "../package.json" and inherits automatically.
//    Only Cargo.toml isn't auto-synced, so warn if it diverges (without
//    blocking the build).
//
// If there's no dmg (= app-only build), silently skip.

import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version: string = pkg.version;

// --- 1) Cargo.toml version check (single source = package.json) ---
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
if (existsSync(cargoPath)) {
  const cargo = readFileSync(cargoPath, 'utf8');
  const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  if (m && m[1] !== version) {
    console.warn(
      `[finalize] WARN: src-tauri/Cargo.toml version "${m[1]}" != package.json "${version}". ` +
        `Cargo.toml is display-only (the bundle uses tauri.conf → package.json), but consider syncing it.`,
    );
  }
}

// --- 2) dmg rename (scan all target directories) ---
// Find release/bundle/dmg so any aarch64 / x86_64 / universal build is caught.
const targetRoot = join(root, 'src-tauri', 'target');
const dmgDirs: string[] = [];
function findDmgDirs(base: string) {
  if (!existsSync(base)) return;
  // target/<triple?>/release/bundle/dmg  or  target/release/bundle/dmg
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const direct = join(base, entry.name, 'release', 'bundle', 'dmg');
    if (existsSync(direct)) dmgDirs.push(direct);
  }
  const flat = join(base, 'release', 'bundle', 'dmg');
  if (existsSync(flat)) dmgDirs.push(flat);
}
findDmgDirs(targetRoot);

let renamed = 0;
for (const dir of dmgDirs) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.dmg')) continue;
    if (file.startsWith('pi-gui_') || file === 'pi-gui.dmg') continue; // already the distribution name
    // productName is "pi", so the original dmg is "pi_<ver>_<arch>.dmg" (or an
    // older version with spaces). Preserve only the trailing "_<ver>_<arch>.dmg"
    // and change it to the distribution name "pi-gui_<ver>_<arch>.dmg".
    const tail = file.match(/_([^_]+)_([^_]+)\.dmg$/);
    const suffix = tail ? `_${tail[1]}_${tail[2]}` : `_${version}`;
    const next = `pi-gui${suffix}.dmg`;
    const from = join(dir, file);
    const to = join(dir, next);
    renameSync(from, to);
    console.log(`[finalize] dmg renamed: "${file}" → "${next}"`);
    renamed++;
  }
}

if (renamed === 0) console.log('[finalize] no dmg to rename (app-only build or already named).');
