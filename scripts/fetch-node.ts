// node 런타임을 받아 Tauri sidecar 로 번들할 바이너리를 만든다.
//
// macOS GUI 앱은 셸 PATH 를 상속하지 않아 시스템 `node` 를 못 찾는 경우가 많다.
// 그래서 node 를 .app 안에 직접 번들한다(externalBin). 백엔드가 .ts 를 native
// strip 으로 직접 실행하므로 번들 node 는 반드시 >=22.19 여야 한다.
//
// 공식 nodejs.org/dist 에서 arm64 + x64 를 받아 SHASUMS256 으로 검증하고,
// lipo 로 universal 을 만든 뒤, 세 바이너리 모두 ad-hoc 코드서명한다.
//   - node 는 universal 바이너리를 배포하지 않으므로 lipo fuse 가 필수.
//   - lipo 는 서명을 무효화한다 → 재서명 안 하면 Apple Silicon 에서 "killed: 9".
//
// 결과물: src-tauri/binaries/node-{aarch64,x86_64,universal}-apple-darwin
// (Tauri externalBin 이 빌드 target triple 을 붙여 찾는다.)
//
// 캐시: 세 바이너리가 다 있고 버전이 맞으면 skip. CI 는 tauri build 전에 돌려야 함.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.20.0'; // pinned, >=22.19 (native TS strip)
const BASE = `https://nodejs.org/dist/${NODE_VERSION}`;
const ARCHES = [
  { node: 'darwin-arm64', triple: 'aarch64-apple-darwin' },
  { node: 'darwin-x64', triple: 'x86_64-apple-darwin' },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src-tauri', 'binaries');

if (platform() !== 'darwin') {
  console.error('[fetch-node] this script targets macOS bundles (lipo/codesign). Skipping.');
  process.exit(0);
}

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function binVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const universalOut = join(OUT, 'node-universal-apple-darwin');
const archOuts = ARCHES.map((a) => join(OUT, `node-${a.triple}`));

// 캐시 체크: 모든 산출물이 존재하고 universal 버전이 일치하면 skip.
const allExist = [universalOut, ...archOuts].every(existsSync);
if (allExist && binVersion(universalOut) === NODE_VERSION) {
  console.log(`[fetch-node] up to date (${NODE_VERSION}) — skipping.`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  const fileStream = createWriteStream(dest);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
  }
  await new Promise<void>((r, j) => fileStream.end((e: unknown) => (e ? j(e) : r())));
}

async function sha256(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

const work = join(tmpdir(), `pi-gui-node-${Date.now()}`);
mkdirSync(work, { recursive: true });

try {
  // SHASUMS256.txt (검증용)
  const shaPath = join(work, 'SHASUMS256.txt');
  await download(`${BASE}/SHASUMS256.txt`, shaPath);
  const sums = (await readFile(shaPath, 'utf8'))
    .split('\n')
    .reduce<Record<string, string>>((acc, line) => {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) acc[m[2]] = m[1];
      return acc;
    }, {});

  for (let i = 0; i < ARCHES.length; i++) {
    const { node } = ARCHES[i];
    const tarName = `node-${NODE_VERSION}-${node}.tar.gz`;
    const tarPath = join(work, tarName);
    console.log(`[fetch-node] downloading ${tarName} ...`);
    await download(`${BASE}/${tarName}`, tarPath);

    const expected = sums[tarName];
    if (!expected) throw new Error(`no SHA256 entry for ${tarName}`);
    const actual = await sha256(tarPath);
    if (actual !== expected) {
      throw new Error(
        `SHA256 mismatch for ${tarName}\n  expected ${expected}\n  actual   ${actual}`,
      );
    }
    console.log(`[fetch-node] verified ${tarName}`);

    // tar 에서 bin/node 만 추출.
    const extractDir = join(work, `x-${node}`);
    mkdirSync(extractDir, { recursive: true });
    sh('tar', ['-xzf', tarPath, '-C', extractDir]);
    const innerNode = join(extractDir, `node-${NODE_VERSION}-${node}`, 'bin', 'node');
    if (!existsSync(innerNode)) throw new Error(`bin/node not found after extracting ${tarName}`);

    sh('cp', [innerNode, archOuts[i]]);
    chmodSync(archOuts[i], 0o755);
  }

  // universal = lipo fuse.
  console.log('[fetch-node] fusing universal binary with lipo ...');
  rmSync(universalOut, { force: true });
  sh('lipo', ['-create', ...archOuts, '-output', universalOut]);
  chmodSync(universalOut, 0o755);

  // lipo 가 서명을 무효화 → 셋 다 ad-hoc 재서명 (없으면 arm64 "killed: 9").
  // 정식 서명은 Tauri 가 app 번들 단계에서 identity 로 다시 한다.
  for (const p of [...archOuts, universalOut]) {
    sh('codesign', ['--force', '--sign', '-', p]);
  }

  // 바이너리는 커밋 제외 (스크립트가 재생성).
  writeFileSync(join(OUT, '.gitignore'), 'node-*\n');

  console.log(`[fetch-node] ready → ${OUT} (node ${NODE_VERSION}, arm64+x64+universal)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
