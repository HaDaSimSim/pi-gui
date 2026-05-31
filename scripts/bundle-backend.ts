// dist-backend 번들 생성 — Tauri 리소스로 들어갈 백엔드.
//
// server/ + shared/ 소스를 복사하고, 런타임에 필요한 node_modules 를 함께 담는다.
// pi SDK 는 이 머신의 글로벌 설치를 symlink 로 참조하므로(문서화된 portability 한계)
// 번들에도 그 실경로를 복사해 넣는다.
//
// 주의: Node strip-only TS 로 그대로 실행하므로 트랜스파일은 하지 않는다.

import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-backend");

// 깨끗하게 다시 생성.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) 소스 복사.
for (const dir of ["server", "shared"]) {
  cpSync(join(root, dir), join(out, dir), { recursive: true, dereference: true });
}

// 2) 런타임 의존성 복사. server 가 import 하는 npm 패키지 + 그 의존성.
//    node 가 dist-backend/node_modules 에서 해석하도록 통째로 복사하되,
//    무거운 dev 전용(vite/tailwind/tauri/typescript)은 제외한다.
const nmSrc = join(root, "node_modules");
const nmOut = join(out, "node_modules");
mkdirSync(nmOut, { recursive: true });

const EXCLUDE = new Set([
  "vite", "@vitejs", "tailwindcss", "@tailwindcss", "typescript",
  "@tauri-apps", "rolldown", "@types",
]);

function copyScope(scopeDir: string, destScopeDir: string) {
  mkdirSync(destScopeDir, { recursive: true });
  for (const pkg of readdirSync(scopeDir)) {
    cpSync(join(scopeDir, pkg), join(destScopeDir, pkg), { recursive: true, dereference: true });
  }
}

for (const entry of readdirSync(nmSrc)) {
  if (entry.startsWith(".")) continue;
  if (EXCLUDE.has(entry)) continue;
  const src = join(nmSrc, entry);
  const dest = join(nmOut, entry);
  if (entry.startsWith("@")) {
    // 스코프: 제외 목록에 없는 하위 패키지만.
    if (EXCLUDE.has(entry)) continue;
    copyScope(src, dest);
  } else {
    cpSync(src, dest, { recursive: true, dereference: true });
  }
}

// 3) 최소 package.json (type:module 등 런타임 힌트).
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "pi-gui-backend", private: true, type: "module" }, null, 2),
);

console.log(`dist-backend ready → ${out}`);
