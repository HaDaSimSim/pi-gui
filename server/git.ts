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

export interface GitCommitFile {
  path: string;
  added: number; // 추가된 줄 (-) 면 binary
  deleted: number;
  status: string; // A/M/D/R 등
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  authorDate: string; // 절대 시각 (ISO-스러운 포맷)
  relTime: string;
  parents: string[];
  refs: string;
  files: GitCommitFile[];
  insertions: number;
  deletions: number;
}

// 해시 검증: git 해시(40 hex 또는 축약)만 허용. 인자 주입 방지.
function isValidHash(h: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(h);
}

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  if (!cwd || !existsSync(cwd) || !isValidHash(hash)) return null;
  const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return null;

  // 메타 + 파일별 numstat 을 한 번에. %x1f 구분, 메타와 numstat 은 %x1e 로 분리.
  const SEP = "%x1f";
  const fmt = ["%H", "%h", "%s", "%b", "%an", "%ae", "%cI", "%cr", "%P", "%D"].join(SEP);
  const out = await git(cwd, ["show", "--no-color", "--numstat", `--format=${fmt}%x1e`, hash]);
  if (!out) return null;

  const [metaPart, statPart = ""] = out.split("\x1e");
  const f = metaPart.split("\x1f");
  if (f.length < 10) return null;

  const files: GitCommitFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of statPart.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split("\t");
    if (cols.length < 3) continue;
    const added = cols[0] === "-" ? 0 : Number(cols[0]) || 0;
    const deleted = cols[1] === "-" ? 0 : Number(cols[1]) || 0;
    let p = cols[2];
    const arrow = p.indexOf(" => ");
    if (arrow >= 0) {
      // rename: "old => new" 또는 "dir/{old => new}/x" — 간단히 new 쪽을 보여준다.
      p = p.replace(/\{.*? => (.*?)\}/, "$1").replace(/.*? => /, "");
    }
    files.push({ path: p, added, deleted, status: cols[0] === "-" ? "B" : "M" });
    insertions += added;
    deletions += deleted;
  }

  return {
    hash: f[0],
    shortHash: f[1],
    subject: f[2],
    body: f[3].trim(),
    author: f[4],
    authorEmail: f[5],
    authorDate: f[6],
    relTime: f[7],
    parents: f[8] ? f[8].split(" ").filter(Boolean) : [],
    refs: f[9] || "",
    files,
    insertions,
    deletions,
  };
}
