// pi-gui 사전 점검 — pi 설치 + 필수 extension 설치 여부.
//
// pi-gui 는 pi 의 SDK/설정/extension 에 얹혀 동작한다. 그것들이 없으면
// 빈 화면이나 혼란스러운 에러 대신 "무엇을 설치해야 하는지" 안내해야 한다.
// 전부 읽기 전용 파일 검사. 런타임/락 불필요.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// pi 의 글로벌 설정 디렉터리. SDK 기본값과 동일 (~/.pi/agent).
function agentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export interface PreflightCheck {
  id: string;
  ok: boolean;
  detail: string; // 사람이 읽을 경로/설명 (UI 표시용)
}

export interface PreflightResult {
  ok: boolean; // 전부 통과했는가
  checks: PreflightCheck[];
}

export function preflight(): PreflightResult {
  const dir = agentDir();
  const checks: PreflightCheck[] = [];

  // 1) pi 가 설치/초기화됐는가 — ~/.pi/agent 디렉터리.
  checks.push({
    id: "pi",
    ok: existsSync(dir),
    detail: dir,
  });

  // 2) 모델 설정 (auth 또는 models). 둘 중 하나라도 있으면 OK.
  const hasAuth = existsSync(join(dir, "auth.json"));
  const hasModels = existsSync(join(dir, "models.json"));
  checks.push({
    id: "models",
    ok: hasAuth || hasModels,
    detail: join(dir, "models.json"),
  });

  // 3) session-lock extension — pi-gui 의 락 규약이 이 extension 과 동일해야
  //    TUI/CLI 와 충돌 감지가 된다. index.ts 가 읽히면 OK (심링크/복사 무관).
  const lockExt = join(dir, "extensions", "session-lock", "index.ts");
  checks.push({
    id: "session-lock",
    ok: existsSync(lockExt),
    detail: lockExt,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
