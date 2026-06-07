// git info queries - all read-only. No runtime/lock needed (same cost model as browsing).
//
// SECURITY: cwd is a value supplied by the client. Use only execFile (array args) and
//   never use shell interpolation. Put a timeout on every command.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// Promise wrapper for execFile. Returns an empty string instead of throwing on failure
// (if git is missing or it's not a repo, just treat it as empty).
function git(cwd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout.toString()),
    );
  });
}

export interface GitFileChange {
  path: string;
  /** Status code of the staged change (git status --porcelain X column). */
  index: string;
  /** Status code of the working-tree change (Y column). */
  work: string;
  /** Untracked new file. */
  untracked: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relTime: string;
  /** Refs this commit points to (HEAD, branches, tags). git log %D. */
  refs: string;
  /** Parent hashes (for drawing the graph). */
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
  /** Short hash when in detached HEAD. */
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

// One porcelain v1 line: "XY <path>" or, on rename, "XY <orig> -> <path>".
function parsePorcelain(out: string): {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
} {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    const x = raw[0];
    const y = raw[1];
    let p = raw.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4); // rename: new path only
    if (x === '?' && y === '?') {
      untracked.push({ path: p, index: '?', work: '?', untracked: true });
      continue;
    }
    if (x !== ' ' && x !== '?') staged.push({ path: p, index: x, work: y, untracked: false });
    if (y !== ' ' && y !== '?') unstaged.push({ path: p, index: x, work: y, untracked: false });
  }
  return { staged, unstaged, untracked };
}

export async function getGitStatus(cwd: string, logLimit = 40): Promise<GitStatus> {
  if (!cwd || !existsSync(cwd)) return EMPTY;

  // Check whether it's a repo first.
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return EMPTY;

  // Query status / branch / upstream / log in parallel.
  const [porc, branchOut, headSym, upstreamOut, aheadBehind, logOut] = await Promise.all([
    git(cwd, ['status', '--porcelain']),
    git(cwd, [
      'for-each-ref',
      '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)',
      'refs/heads',
    ]),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    git(cwd, [
      'log',
      `-${logLimit}`,
      '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%D%x1f%P',
      '--all',
      '--date-order',
    ]),
  ]);

  const { staged, unstaged, untracked } = parsePorcelain(porc);

  const branch = headSym.trim() || null;
  const head = branch ? null : (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim() || null;
  const upstream = upstreamOut.trim() || null;

  let ahead = 0;
  let behind = 0;
  const ab = aheadBehind.trim().split(/\s+/);
  if (ab.length === 2) {
    ahead = Number(ab[0]) || 0;
    behind = Number(ab[1]) || 0;
  }

  const branches: GitBranch[] = branchOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, headFlag, up] = line.split('\t');
      return { name, current: headFlag === '*', upstream: up || null };
    });

  const commits: GitCommit[] = logOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, relTime, refs, parents] = line.split('\x1f');
      return {
        hash,
        shortHash,
        subject,
        author,
        relTime,
        refs: refs || '',
        parents: parents ? parents.split(' ').filter(Boolean) : [],
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
  added: number; // added lines; (-) means binary
  deleted: number;
  status: string; // A/M/D/R, etc.
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  authorDate: string; // absolute time (ISO-ish format)
  relTime: string;
  parents: string[];
  refs: string;
  files: GitCommitFile[];
  insertions: number;
  deletions: number;
}

// Hash validation: allow only a git hash (40 hex or abbreviated). Prevents argument injection.
function isValidHash(h: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(h);
}

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  if (!cwd || !existsSync(cwd) || !isValidHash(hash)) return null;
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return null;

  // Meta + per-file numstat in one go. %x1f as the separator; meta and numstat split by %x1e.
  const SEP = '%x1f';
  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%cI', '%cr', '%P', '%D'].join(SEP);
  const out = await git(cwd, ['show', '--no-color', '--numstat', `--format=${fmt}%x1e`, hash]);
  if (!out) return null;

  const [metaPart, statPart = ''] = out.split('\x1e');
  const f = metaPart.split('\x1f');
  if (f.length < 10) return null;

  const files: GitCommitFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of statPart.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t');
    if (cols.length < 3) continue;
    const added = cols[0] === '-' ? 0 : Number(cols[0]) || 0;
    const deleted = cols[1] === '-' ? 0 : Number(cols[1]) || 0;
    let p = cols[2];
    const arrow = p.indexOf(' => ');
    if (arrow >= 0) {
      // rename: "old => new" or "dir/{old => new}/x" - simply show the new side.
      p = p.replace(/\{.*? => (.*?)\}/, '$1').replace(/.*? => /, '');
    }
    files.push({ path: p, added, deleted, status: cols[0] === '-' ? 'B' : 'M' });
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
    parents: f[8] ? f[8].split(' ').filter(Boolean) : [],
    refs: f[9] || '',
    files,
    insertions,
    deletions,
  };
}
