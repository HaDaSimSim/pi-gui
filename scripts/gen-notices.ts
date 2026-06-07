// Generate THIRD-PARTY-NOTICES.md — collect the license notices for the packages
// actually bundled into dist-backend/node_modules.
//
// MIT/Apache-2.0/ISC and friends require shipping the original copyright notice
// on redistribution. Most packages ship their own LICENSE file (which cpSync
// bundles as-is), but some (the pi SDK, etc.) have no LICENSE in the tarball.
// This script reads each package's package.json (license/author) and includes
// the bundled LICENSE text when present; otherwise it puts at least the SPDX
// license name + author into the notice to avoid omissions.
//
// Run after bundle:backend (dist-backend must exist). If dist-backend is
// missing, fall back to scanning the root node_modules so it can be generated
// ahead of time during development.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Prefer the bundle; fall back to the root node_modules.
const nmDir = existsSync(join(root, 'dist-backend', 'node_modules'))
  ? join(root, 'dist-backend', 'node_modules')
  : join(root, 'node_modules');

interface Pkg {
  name: string;
  version: string;
  license: string;
  author: string;
  homepage: string;
  licenseText: string | null;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE'];

function readLicenseText(pkgDir: string): string | null {
  for (const f of LICENSE_FILES) {
    const p = join(pkgDir, f);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8').trim();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function authorString(a: unknown): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    const o = a as { name?: string; email?: string };
    return [o.name, o.email ? `<${o.email}>` : ''].filter(Boolean).join(' ');
  }
  return '';
}

function readPkg(pkgDir: string): Pkg | null {
  const pjPath = join(pkgDir, 'package.json');
  if (!existsSync(pjPath)) return null;
  let pj: any;
  try {
    pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  } catch {
    return null;
  }
  if (!pj.name) return null;
  const license =
    pj.license ||
    (Array.isArray(pj.licenses) ? pj.licenses.map((l: any) => l.type).join(', ') : '') ||
    'UNKNOWN';
  return {
    name: pj.name,
    version: pj.version ?? '',
    license,
    author: authorString(pj.author),
    homepage: pj.homepage || pj.repository?.url || '',
    licenseText: readLicenseText(pkgDir),
  };
}

// Scan node_modules one level deep (including scopes) to collect packages.
function collect(): Pkg[] {
  const out: Pkg[] = [];
  if (!existsSync(nmDir)) return out;
  for (const entry of readdirSync(nmDir)) {
    if (entry.startsWith('.')) continue;
    const full = join(nmDir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(full)) {
        const p = readPkg(join(full, sub));
        if (p) out.push(p);
      }
    } else {
      const p = readPkg(full);
      if (p) out.push(p);
    }
  }
  return out;
}

const pkgs = collect().sort((a, b) => a.name.localeCompare(b.name));

const lines: string[] = [];
lines.push('# Third-Party Notices');
lines.push('');
lines.push(
  'pi-gui bundles the following third-party packages in its distributed backend ' +
    '(`dist-backend/node_modules`). Each retains its own license, reproduced below.',
);
lines.push('');
lines.push(`Generated from \`${nmDir.replace(`${root}/`, '')}\` — ${pkgs.length} packages.`);
lines.push('');

// License summary table.
lines.push('## Summary');
lines.push('');
lines.push('| Package | Version | License |');
lines.push('| --- | --- | --- |');
for (const p of pkgs) {
  lines.push(`| ${p.name} | ${p.version} | ${p.license} |`);
}
lines.push('');

// Non-permissive warning (may block distribution).
const COPYLEFT = /GPL|AGPL|LGPL|MPL|EUPL|CDDL|EPL/i;
const flagged = pkgs.filter((p) => COPYLEFT.test(p.license));
if (flagged.length) {
  lines.push('## ⚠ Copyleft / restrictive licenses detected');
  lines.push('');
  for (const p of flagged) lines.push(`- ${p.name}@${p.version} — ${p.license}`);
  lines.push('');
}

lines.push('## Full notices');
lines.push('');
for (const p of pkgs) {
  lines.push(`### ${p.name}@${p.version} (${p.license})`);
  lines.push('');
  if (p.author) lines.push(`Author: ${p.author}  `);
  if (p.homepage) lines.push(`Homepage: ${p.homepage}  `);
  lines.push('');
  if (p.licenseText) {
    lines.push('```');
    lines.push(p.licenseText);
    lines.push('```');
  } else {
    lines.push(
      `_No license file shipped in this package's tarball. Distributed under its ` +
        `declared \`${p.license}\` license; see the package homepage for full terms._`,
    );
  }
  lines.push('');
}

const outPath = join(root, 'THIRD-PARTY-NOTICES.md');
writeFileSync(outPath, lines.join('\n'));
console.log(
  `THIRD-PARTY-NOTICES.md ready → ${pkgs.length} packages` +
    (flagged.length ? ` (⚠ ${flagged.length} copyleft flagged)` : ''),
);
