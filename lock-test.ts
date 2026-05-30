// 락 규약 검증. 두 점유자(A=pi, B=pi-web)를 한 프로세스 안에서 흉내낸다.
// 실제로는 토큰이 프로세스/인스턴스마다 다르므로, SessionLock 인스턴스 2개로 모사.
import { SessionLock, listLocks } from "./shared/session-lock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-lock-test-"));
const SESSION = "/fake/project/session-abc.jsonl";
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

console.log("1) free → A가 잡으면 성공, A의 것");
const A = new SessionLock(SESSION, "pi", "TUI", dir);
const B = new SessionLock(SESSION, "pi-web", "pi-web", dir);
{
  const r = A.tryAcquire();
  ok(r.acquired, "A.tryAcquire() 성공");
  ok(A.isMine(), "A.isMine() === true");
}

console.log("2) A가 점유 중일 때 B는 거부당함 (자동 탈취 없음)");
{
  const r = B.tryAcquire();
  ok(!r.acquired, "B.tryAcquire() 실패");
  ok(r.current?.owner === "pi", `현재 점유자 = pi (got ${r.current?.owner})`);
  ok(!B.isMine(), "B.isMine() === false");
}

console.log("3) 보내기 직전 확인: 이 시점엔 여전히 A의 것");
ok(A.isMine(), "A는 아직 자기 락 보유");

console.log("4) B가 강제 탈취(takeover) → 이제 B의 것, A는 lost");
{
  const { takenFrom } = B.takeover();
  ok(takenFrom?.owner === "pi", `B가 pi로부터 탈취 (got ${takenFrom?.owner})`);
  ok(B.isMine(), "B.isMine() === true");
  ok(!A.isMine(), "A.isMine() === false (더 이상 A 것 아님)");
  ok(A.isLost(), "A.isLost() === true (쫓겨남 감지)");
}

console.log("5) 핵심: 보내기 직전 A가 확인하면 차단되어야 함");
{
  const aState = A.state().state;
  ok(aState === "lost", `A.state() === "lost" (got "${aState}")`);
  // → extension/runtime 은 이 시점에 cancel/dispose 한다
}

console.log("6) lost 된 A가 release 해도 B 락은 안 건드림");
{
  A.release(); // A는 자기 것 아니므로 파일 안 지움
  ok(B.isMine(), "A.release() 후에도 B는 여전히 점유");
  const locks = listLocks(dir);
  ok(locks.length === 1 && locks[0].owner === "pi-web", "락 디렉터리에 pi-web 락만 존재");
}

console.log("7) B가 정상 release → free");
{
  B.release();
  ok(listLocks(dir).length === 0, "release 후 락 0개");
  const C = new SessionLock(SESSION, "pi", "TUI2", dir);
  ok(C.tryAcquire().acquired, "이제 새 점유자가 잡을 수 있음");
  C.release();
}

console.log("8) 조망: listLocks 가 전체를 본다 (pi-web 대시보드용)");
{
  const s1 = new SessionLock("/p/s1.jsonl", "pi", "TUI-1", dir);
  const s2 = new SessionLock("/p/s2.jsonl", "pi-web", "web-2", dir);
  s1.tryAcquire();
  s2.tryAcquire();
  const locks = listLocks(dir);
  ok(locks.length === 2, `listLocks 가 2개 모두 봄 (got ${locks.length})`);
  ok(
    locks.some((l) => l.label === "TUI-1") && locks.some((l) => l.label === "web-2"),
    "라벨로 누가 뭘 점유 중인지 식별 가능",
  );
  s1.release();
  s2.release();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
