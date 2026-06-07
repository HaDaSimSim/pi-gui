// 빌드 후처리 — 두 가지를 한다.
//
// 1) dmg 파일명에서 공백 제거. Tauri 는 productName("π (pi)") 을 그대로
//    파일명에 박아 "π (pi)_<ver>_<arch>.dmg" 를 만든다. 앱 번들/실행파일
//    이름(브랜딩)은 그대로 두고, 배포물 dmg 만 "pi-gui_<ver>_<arch>.dmg" 로
//    rename 한다. (Tauri v2 엔 dmg 전용 파일명 옵션이 없어 후처리로 한다.)
//
// 2) 버전 단일 소스 확인. package.json 이 source of truth. tauri.conf.json 은
//    "../package.json" 을 가리켜 자동 상속한다. Cargo.toml 만 자동 동기화가
//    안 되므로, 어긋나면 경고한다(빌드는 막지 않음).
//
// dmg 가 없으면(=app-only 빌드) 조용히 넘어간다.

import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version: string = pkg.version;

// --- 1) Cargo.toml 버전 점검 (단일 소스 = package.json) ---
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

// --- 2) dmg rename (모든 target 디렉터리 훑기) ---
// aarch64 / x86_64 / universal 어느 빌드든 잡히도록 release/bundle/dmg 를 찾는다.
const targetRoot = join(root, 'src-tauri', 'target');
const dmgDirs: string[] = [];
function findDmgDirs(base: string) {
  if (!existsSync(base)) return;
  // target/<triple?>/release/bundle/dmg  또는  target/release/bundle/dmg
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
    if (file.startsWith('pi-gui_') || file === 'pi-gui.dmg') continue; // 이미 배포명
    // productName 이 "pi" 라 dmg 원본은 "pi_<ver>_<arch>.dmg" (또는 공백 포함 구판).
    // 끝쪽 "_<ver>_<arch>.dmg" 만 보존해 배포명 "pi-gui_<ver>_<arch>.dmg" 로 바꿼다.
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
