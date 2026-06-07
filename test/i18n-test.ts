// i18n verification — en/ko key sets match exactly (parity) + interpolation behavior.
//
// i18n.ts has useT() depending on React, so instead of importing the module here,
// it parses the two dictionaries from source and compares only the key sets (run with node, like lock-test).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../web/i18n.ts'), 'utf8');

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

console.log('i18n parity');
ok(!!enBlock, 'en 사전 블록 파싱됨');
ok(!!koBlock, 'ko 사전 블록 파싱됨');

if (enBlock && koBlock) {
  const en = keysOf(enBlock[1]);
  const ko = keysOf(koBlock[1]);
  const enSet = new Set(en);
  const koSet = new Set(ko);

  ok(en.length === enSet.size, `en 키 중복 없음 (${en.length})`);
  ok(ko.length === koSet.size, `ko 키 중복 없음 (${ko.length})`);

  const missingInKo = [...enSet].filter((k) => !koSet.has(k));
  const extraInKo = [...koSet].filter((k) => !enSet.has(k));
  ok(
    missingInKo.length === 0,
    `ko 에 빠진 키 없음 ${missingInKo.length ? `→ ${missingInKo.join(', ')}` : ''}`,
  );
  ok(
    extraInKo.length === 0,
    `ko 에 잉여 키 없음 ${extraInKo.length ? `→ ${extraInKo.join(', ')}` : ''}`,
  );
  ok(enSet.size === koSet.size, `en/ko 키 수 일치 (${enSet.size})`);

  // Whether interpolation tokens ({x}) exist on both sides (if only one has it, {x} leaks at runtime)
  const enMap = new Map(
    [...enBlock[1].matchAll(/"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
  );
  const koMap = new Map(
    [...koBlock[1].matchAll(/"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
  );
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
  ok(mismatched === 0, '보간 토큰이 en/ko 양쪽 일치');
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
