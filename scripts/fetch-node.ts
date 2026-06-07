// Fetch the node runtime and build the binary to bundle as a Tauri sidecar.
//
// macOS GUI apps don't inherit the shell PATH, so they often can't find the
// system `node`. We therefore bundle node directly inside the .app (externalBin).
// The backend runs .ts directly via native strip, so the bundled node must be
// >=22.19.
//
// Download arm64 + x64 from the official nodejs.org/dist, verify with SHASUMS256,
// fuse a universal with lipo, then ad-hoc code-sign all three binaries.
//   - node ships no universal binary, so the lipo fuse is required.
//   - lipo invalidates the signature → without re-signing, "killed: 9" on Apple Silicon.
//
// Output: src-tauri/binaries/node-{aarch64,x86_64,universal}-apple-darwin
// (Tauri externalBin appends the build target triple when looking it up.)
//
// Cache: skip if all three binaries exist and the version matches. CI must run
// this before tauri build.

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

// Cache check: skip if all outputs exist and the universal version matches.
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
  // SHASUMS256.txt (for verification)
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

    // Extract only bin/node from the tar.
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

  // lipo invalidates the signature → ad-hoc re-sign all three (else arm64 "killed: 9").
  // The real signing is redone by Tauri with an identity during the app bundle step.
  for (const p of [...archOuts, universalOut]) {
    sh('codesign', ['--force', '--sign', '-', p]);
  }

  // Exclude the binaries from commits (the script regenerates them).
  writeFileSync(join(OUT, '.gitignore'), 'node-*\n');

  console.log(`[fetch-node] ready → ${OUT} (node ${NODE_VERSION}, arm64+x64+universal)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
