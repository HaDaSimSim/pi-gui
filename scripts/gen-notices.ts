// THIRD-PARTY-NOTICES.md 생성 — dist-backend/node_modules 에 실제로 번들되는
// 패키지들의 라이선스 고지를 모은다.
//
// MIT/Apache-2.0/ISC 등은 재배포 시 원저작권 고지를 함께 실어야 한다. 대부분
// 패키지는 자체 LICENSE 파일을 동봉하지만(그건 cpSync 로 그대로 번들됨),
// 일부(pi SDK 등)는 tarball 에 LICENSE 가 없다. 이 스크립트는 각 패키지의
// package.json(license/author) 을 읽고, 동봉된 LICENSE 본문이 있으면 그대로,
// 없으면 SPDX 라이선스명 + 저작자만이라도 고지에 넣어 누락을 막는다.
//
// bundle:backend 이후에 돌린다 (dist-backend 가 있어야 함). dist-backend 가
// 없으면 루트 node_modules 를 대신 훑어 개발 중에도 미리 만들 수 있다.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 번들 우선, 없으면 루트 node_modules.
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

// node_modules 를 한 단계(스코프 포함) 훑어 패키지를 모은다.
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

// 라이선스 요약 표.
lines.push('## Summary');
lines.push('');
lines.push('| Package | Version | License |');
lines.push('| --- | --- | --- |');
for (const p of pkgs) {
  lines.push(`| ${p.name} | ${p.version} | ${p.license} |`);
}
lines.push('');

// 비-permissive 경고 (배포 차단 가능성).
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
