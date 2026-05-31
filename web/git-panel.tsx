// git 패널 — info 패널의 "Git" 탭. 전부 읽기 전용.
// 브랜치 목록, 변경 파일(staged/unstaged/untracked), 최근 커밋 그래프.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, GitBranch as GitBranchIcon, Check, GitCommit as GitCommitIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, type GitStatus, type GitFileChange, type GitCommit, type GitCommitDetail } from "./api";
import { useT } from "./i18n";

// status 코드 → 색상/라벨. (M 수정, A 추가, D 삭제, R 이름변경, ? 미추적)
function codeMeta(code: string): { label: string; cls: string } {
  switch (code) {
    case "M":
      return { label: "M", cls: "text-amber-500" };
    case "A":
      return { label: "A", cls: "text-emerald-500" };
    case "D":
      return { label: "D", cls: "text-destructive" };
    case "R":
      return { label: "R", cls: "text-sky-500" };
    case "?":
      return { label: "U", cls: "text-muted-foreground" };
    default:
      return { label: code.trim() || "•", cls: "text-muted-foreground" };
  }
}

function FileRow({ change, side }: { change: GitFileChange; side: "index" | "work" }) {
  const code = side === "index" ? change.index : change.work;
  const meta = codeMeta(change.untracked ? "?" : code);
  // 경로를 디렉터리/파일명으로 분리해 파일명을 강조.
  const slash = change.path.lastIndexOf("/");
  const dir = slash >= 0 ? change.path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? change.path.slice(slash + 1) : change.path;
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-sm">
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", meta.cls)}>{meta.label}</span>
      <span className="min-w-0 truncate">
        {dir ? <span className="text-muted-foreground">{dir}</span> : null}
        <span>{file}</span>
      </span>
    </div>
  );
}

function FileGroup({
  title,
  files,
  side,
}: {
  title: string;
  files: GitFileChange[];
  side: "index" | "work";
}) {
  if (!files.length) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <span>{title}</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px]">{files.length}</span>
      </div>
      {files.map((f) => (
        <FileRow key={`${side}:${f.path}`} change={f} side={side} />
      ))}
    </div>
  );
}

// 단순 커밋 그래프: 각 커밋 앞에 점 + 세로 연결선. 클릭하면 상세를 연다.
function CommitRow({
  commit,
  isLast,
  onSelect,
}: {
  commit: GitCommit;
  isLast: boolean;
  onSelect: (hash: string) => void;
}) {
  const isMerge = commit.parents.length > 1;
  const refs = commit.refs
    ? commit.refs.split(",").map((r) => r.trim().replace(/^HEAD -> /, "")).filter(Boolean)
    : [];
  return (
    <button type="button" onClick={() => onSelect(commit.hash)} className="flex gap-2.5 text-left">
      {/* 그래프 레인 */}
      <div className="relative flex w-3 shrink-0 flex-col items-center">
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full border-2",
            isMerge ? "border-violet-500 bg-background" : "border-sky-500 bg-sky-500",
          )}
        />
        {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
      </div>
      {/* 커밋 내용 */}
      <div className="-mx-1 min-w-0 flex-1 rounded px-1 pb-3 hover:bg-accent">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm">{commit.subject}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{commit.shortHash}</span>
          <span>{commit.author}</span>
          <span>{commit.relTime}</span>
          {refs.map((r) => (
            <span key={r} className="rounded bg-muted px-1.5 font-mono text-[11px] text-foreground/80">
              {r}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

// 커밋 상세 다이얼로그: 메시지 전문 + 변경 파일(numstat).
function CommitDetailDialog({
  cwd,
  hash,
  onClose,
}: {
  cwd: string;
  hash: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .gitCommit(cwd, hash)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd, hash]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6 text-base">
            <GitCommitIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{detail?.subject ?? t("git.loading")}</span>
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("git.loading")}</div>
        ) : !detail ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("git.error")}</div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pt-2">
            {/* 메타 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono text-foreground/80">{detail.shortHash}</span>
              <span>·</span>
              <span>{detail.author}</span>
              {detail.authorEmail ? <span className="font-mono">&lt;{detail.authorEmail}&gt;</span> : null}
              <span>·</span>
              <span>{detail.relTime}</span>
            </div>
            {detail.parents.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("git.parents")}:</span>
                {detail.parents.map((p) => (
                  <span key={p} className="rounded bg-muted px-1.5 font-mono text-[11px]">{p.slice(0, 7)}</span>
                ))}
              </div>
            ) : null}

            {/* 메시지 본문 */}
            {detail.body ? (
              <pre className="m-0 whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground/80">
                {detail.body}
              </pre>
            ) : null}

            {/* 변경 파일 */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>{t("git.filesChanged", { count: detail.files.length })}</span>
                {detail.insertions > 0 ? <span className="text-emerald-500">+{detail.insertions}</span> : null}
                {detail.deletions > 0 ? <span className="text-destructive">−{detail.deletions}</span> : null}
              </div>
              <div className="flex flex-col">
                {detail.files.map((fl) => {
                  const slash = fl.path.lastIndexOf("/");
                  const dir = slash >= 0 ? fl.path.slice(0, slash + 1) : "";
                  const name = slash >= 0 ? fl.path.slice(slash + 1) : fl.path;
                  return (
                    <div key={fl.path} className="flex items-center gap-2 py-0.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        {dir ? <span className="text-muted-foreground">{dir}</span> : null}
                        <span>{name}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-emerald-500">+{fl.added}</span>
                      <span className="shrink-0 font-mono text-[11px] text-destructive">−{fl.deleted}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function GitPanel({ path, cwd }: { path: string; cwd?: string }) {
  const { t } = useT();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(cwd ?? null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // cwd 가 안 주어지면 footer 로 세션의 cwd 를 먼저 알아낸다.
      let dir = cwd;
      if (!dir) {
        const f = await api.footer(path).catch(() => null);
        dir = f?.cwd || undefined;
      }
      if (!dir) {
        setError(t("git.noCwd"));
        setStatus(null);
        return;
      }
      setResolvedCwd(dir);
      setStatus(await api.git(dir));
    } catch (e) {
      // 라우트 없음(구버전 서버)/네트워크 오류 등 — "repo 아님"과 구분해 표시.
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [path, cwd, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !status) {
    return <div className="p-4 text-sm text-muted-foreground">{t("git.loading")}</div>;
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
        <div>{t("git.error")}</div>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">{error}</code>
        <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={load}>
          <RefreshCw className="size-3.5" /> {t("git.refresh")}
        </Button>
      </div>
    );
  }
  if (!status || !status.isRepo) {
    return <div className="p-4 text-sm text-muted-foreground">{t("git.notRepo")}</div>;
  }

  const dirty = status.staged.length + status.unstaged.length + status.untracked.length;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 헤더: 현재 브랜치 + 새로고침 */}
      <div className="flex items-center gap-2">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {status.branch ?? `${t("git.detached")} ${status.head ?? ""}`}
        </span>
        {status.ahead > 0 ? <span className="text-xs text-emerald-500">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="text-xs text-amber-500">↓{status.behind}</span> : null}
        <Button variant="ghost" size="icon" className="size-7" aria-label={t("git.refresh")} onClick={load}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {status.upstream ? (
        <div className="-mt-2 pl-6 text-xs text-muted-foreground">{status.upstream}</div>
      ) : null}

      {/* 변경 파일 */}
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("git.changes")}</div>
        {dirty === 0 ? (
          <div className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
            <Check className="size-3.5 text-emerald-500" /> {t("git.clean")}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <FileGroup title={t("git.staged")} files={status.staged} side="index" />
            <FileGroup title={t("git.unstaged")} files={status.unstaged} side="work" />
            <FileGroup title={t("git.untracked")} files={status.untracked} side="work" />
          </div>
        )}
      </div>

      {/* 브랜치 목록 (접이식) */}
      {status.branches.length > 1 ? (
        <Collapsible>
          <CollapsibleTrigger className="text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
            {t("git.branches")} ({status.branches.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 flex flex-col gap-0.5">
            {status.branches.map((b) => (
              <div key={b.name} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                <span className={cn("w-3 shrink-0 text-center", b.current ? "text-emerald-500" : "text-transparent")}>•</span>
                <span className={cn("min-w-0 truncate", b.current && "font-medium")}>{b.name}</span>
                {b.upstream ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{b.upstream}</span> : null}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {/* 커밋 그래프 */}
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("git.commits")}</div>
        <div className="flex flex-col">
          {status.commits.length === 0 ? (
            <div className="px-1 text-sm text-muted-foreground">{t("git.noCommits")}</div>
          ) : (
            status.commits.map((cm, i) => (
              <CommitRow
                key={cm.hash}
                commit={cm}
                isLast={i === status.commits.length - 1}
                onSelect={setSelectedHash}
              />
            ))
          )}
        </div>
      </div>

      {/* 커밋 상세 다이얼로그 */}
      {selectedHash && resolvedCwd ? (
        <CommitDetailDialog cwd={resolvedCwd} hash={selectedHash} onClose={() => setSelectedHash(null)} />
      ) : null}
    </div>
  );
}
