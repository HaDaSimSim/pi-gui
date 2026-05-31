// git 정보 조회 — 전부 읽기 전용. 런타임/락 불필요 (브라우징과 동일 비용 모델).
//
// SECURITY: cwd 는 클라이언트가 주는 값이다. execFile(배열 인자)만 쓰고
//   shell 보간은 절대 쓰지 않는다. 모든 명령에 timeout 을 건다.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// execFile 의 Promise 래퍼. 실패해도 throw 하지 않고 빈 문자열을 준다
// (git 이 없거나 repo 가 아니면 그냥 비어 있음으로 처리).
function git(cwd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? "" : stdout.toString()),
    );
  });
}

export interface GitFileChange {
  path: string;
  /** 스테이징된 변경의 상태 코드 (git status --porcelain X열). */
  index: string;
  /** 작업트리 변경의 상태 코드 (Y열). */
  work: string;
  /** 추적되지 않는 새 파일. */
  untracked: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relTime: string;
  /** 이 커밋이 가리키는 ref 들 (HEAD, 브랜치, 태그). git log %D. */
  refs: string;
  /** 부모 해시들 (그래프 그리기용). */
  parents: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  /** detached HEAD 면 짧은 해시. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branches: GitBranch[];
  commits: GitCommit[];
}

const EMPTY: GitStatus = {
  isRepo: false,
  branch: null,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  branches: [],
  commits: [],
};

// porcelain v1 한 줄: "XY <path>" 또는 rename 시 "XY <orig> -> <path>".
function parsePorcelain(out: string): {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
} {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const x = raw[0];
    const y = raw[1];
    let p = raw.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4); // rename: 새 경로만
    if (x === "?" && y === "?") {
      untracked.push({ path: p, index: "?", work: "?", untracked: true });
      continue;
    }
    if (x !== " " && x !== "?") staged.push({ path: p, index: x, work: y, untracked: false });
    if (y !== " " && y !== "?") unstaged.push({ path: p, index: x, work: y, untracked: false });
  }
  return { staged, unstaged, untracked };
}

export async function getGitStatus(cwd: string, logLimit = 40): Promise<GitStatus> {
  if (!cwd || !existsSync(cwd)) return EMPTY;

  // repo 여부 먼저 확인.
  const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return EMPTY;

  // 병렬로 status / branch / upstream / log 조회.
  const [porc, branchOut, headSym, upstreamOut, aheadBehind, logOut] = await Promise.all([
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["for-each-ref", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)", "refs/heads"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    git(cwd, [
      "log",
      `-${logLimit}`,
      "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%D%x1f%P",
      "--all",
      "--date-order",
    ]),
  ]);

  const { staged, unstaged, untracked } = parsePorcelain(porc);

  const branch = headSym.trim() || null;
  const head = branch ? null : (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() || null;
  const upstream = upstreamOut.trim() || null;

  let ahead = 0;
  let behind = 0;
  const ab = aheadBehind.trim().split(/\s+/);
  if (ab.length === 2) {
    ahead = Number(ab[0]) || 0;
    behind = Number(ab[1]) || 0;
  }

  const branches: GitBranch[] = branchOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, headFlag, up] = line.split("\t");
      return { name, current: headFlag === "*", upstream: up || null };
    });

  const commits: GitCommit[] = logOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, relTime, refs, parents] = line.split("\x1f");
      return {
        hash,
        shortHash,
        subject,
        author,
        relTime,
        refs: refs || "",
        parents: parents ? parents.split(" ").filter(Boolean) : [],
      };
    });

  return {
    isRepo: true,
    branch,
    head,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    branches,
    commits,
  };
}
