// Build the dist-backend bundle - the backend that goes into Tauri resources.
//
// Copies the server/ + shared/ sources and installs only the npm packages the backend
// actually imports, precisely down to their transitive dependencies.
//
// The proper way: don't scrape the root node_modules (mixes in frontend deps + risk of
// missing transitive deps in pnpm's nested .pnpm structure). Instead, use a backend-only
// package.json and run `pnpm install --prod` inside dist-backend. This produces a
// self-contained tree that node can resolve directly.
//
// Note: it runs as-is under Node strip-only TS, so no transpilation is done.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-backend');

// External packages the backend (server/ + shared/) actually imports.
// (Excludes node: builtins and relative-path imports. Add here as imports grow.)
const BACKEND_DEPS = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@hono/node-server',
  '@hono/node-ws',
  'hono',
];

// Recreate from clean.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) Copy sources. shared/session-lock.ts is a symlink into the vendor submodule.
//    cpSync's dereference can leave a nested symlink as an absolute-path symlink
//    (breaks on another machine). So after copying, replace any remaining symlinks with
//    their real contents to always make them real files (a self-contained bundle).
for (const dir of ['server', 'shared']) {
  cpSync(join(root, dir), join(out, dir), { recursive: true, dereference: true });
}
function materializeSymlinks(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const content = readFileSync(p); // follow the symlink and read its real contents
      rmSync(p);
      writeFileSync(p, content);
    } else if (st.isDirectory()) {
      materializeSymlinks(p);
    }
  }
}
materializeSymlinks(join(out, 'shared'));
materializeSymlinks(join(out, 'server'));

// 2) Pin the backend deps' versions by pulling them from the root package.json.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rootDeps: Record<string, string> = rootPkg.dependencies ?? {};
const deps: Record<string, string> = {};
for (const name of BACKEND_DEPS) {
  if (!rootDeps[name]) {
    throw new Error(`backend dep "${name}" not found in root package.json dependencies`);
  }
  deps[name] = rootDeps[name];
}

// 3) Backend-only package.json (type:module + exact deps).
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    { name: 'pi-gui-backend', private: true, type: 'module', dependencies: deps },
    null,
    2,
  ),
);

// 4) Install production dependencies inside dist-backend.
//    Flatten with hoisted, but pnpm's .pnpm virtual store (relative symlinks) is also
//    bundled as-is -> node resolves transitive deps (ws, etc.) correctly.
//    --ignore-scripts: don't run build scripts (native compilation, etc.) in the bundle.
writeFileSync(join(out, '.npmrc'), 'node-linker=hoisted\n');
console.log('[bundle-backend] installing backend production deps …');
execFileSync('pnpm', ['install', '--prod', '--no-frozen-lockfile', '--ignore-scripts'], {
  cwd: out,
  stdio: 'inherit',
});

console.log(`dist-backend ready → ${out}`);
