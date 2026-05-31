// i18n 검증 — en/ko 키 집합이 정확히 일치하는지(parity) + 보간 동작.
//
// i18n.ts 는 useT() 가 React 에 의존하므로, 여기선 모듈을 import 하지 않고
// 소스에서 두 사전을 파싱해 키 집합만 비교한다 (lock-test 와 동일하게 node 로 실행).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../web/i18n.ts"), "utf8");

let pass = 0,
  fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.log(`  ❌ ${msg}`);
  }
};

function keysOf(block: string): string[] {
  return [...block.matchAll(/"([\w.]+)":/g)].map((m) => m[1]);
}

const enBlock = src.match(/const en = \{([\s\S]*?)\} as const;/);
const koBlock = src.match(/const ko: Record<I18nKey, string> = \{([\s\S]*?)\n\};/);

console.log("i18n parity");
ok(!!enBlock, "en 사전 블록 파싱됨");
ok(!!koBlock, "ko 사전 블록 파싱됨");

if (enBlock && koBlock) {
  const en = keysOf(enBlock[1]);
  const ko = keysOf(koBlock[1]);
  const enSet = new Set(en);
  const koSet = new Set(ko);

  ok(en.length === enSet.size, `en 키 중복 없음 (${en.length})`);
  ok(ko.length === koSet.size, `ko 키 중복 없음 (${ko.length})`);

  const missingInKo = [...enSet].filter((k) => !koSet.has(k));
  const extraInKo = [...koSet].filter((k) => !enSet.has(k));
  ok(missingInKo.length === 0, `ko 에 빠진 키 없음 ${missingInKo.length ? "→ " + missingInKo.join(", ") : ""}`);
  ok(extraInKo.length === 0, `ko 에 잉여 키 없음 ${extraInKo.length ? "→ " + extraInKo.join(", ") : ""}`);
  ok(enSet.size === koSet.size, `en/ko 키 수 일치 (${enSet.size})`);

  // 보간 토큰({x})이 양쪽에 같이 존재하는지 (한쪽만 있으면 런타임에 {x} 가 노출됨)
  const enMap = new Map([...enBlock[1].matchAll(/"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
  const koMap = new Map([...koBlock[1].matchAll(/"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
  const tokenRe = /\{(\w+)\}/g;
  let mismatched = 0;
  for (const [k, enVal] of enMap) {
    const koVal = koMap.get(k);
    if (koVal == null) continue;
    const enTokens = new Set([...enVal.matchAll(tokenRe)].map((m) => m[1]));
    const koTokens = new Set([...koVal.matchAll(tokenRe)].map((m) => m[1]));
    const same = enTokens.size === koTokens.size && [...enTokens].every((tkn) => koTokens.has(tkn));
    if (!same) {
      mismatched++;
      console.log(`     ⚠ ${k}: en{${[...enTokens]}} vs ko{${[...koTokens]}}`);
    }
  }
  ok(mismatched === 0, "보간 토큰이 en/ko 양쪽 일치");
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
