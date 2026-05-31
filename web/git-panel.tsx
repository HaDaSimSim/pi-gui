// git 패널 — info 패널의 "Git" 탭. 전부 읽기 전용.
// 브랜치 목록, 변경 파일(staged/unstaged/untracked), 최근 커밋 그래프.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, GitBranch as GitBranchIcon, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { api, type GitStatus, type GitFileChange, type GitCommit } from "./api";
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

// 단순 커밋 그래프: 각 커밋 앞에 점 + 세로 연결선. (선형 위주, 머지는 점만 강조)
function CommitRow({ commit, isLast }: { commit: GitCommit; isLast: boolean }) {
  const isMerge = commit.parents.length > 1;
  const refs = commit.refs
    ? commit.refs.split(",").map((r) => r.trim().replace(/^HEAD -> /, "")).filter(Boolean)
    : [];
  return (
    <div className="flex gap-2.5">
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
      <div className="min-w-0 flex-1 pb-3">
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
    </div>
  );
}

export function GitPanel({ path, cwd }: { path: string; cwd?: string }) {
  const { t } = useT();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // cwd 가 안 주어지면 footer 로 세션의 cwd 를 먼저 알아낸다.
      let dir = cwd;
      if (!dir) {
        const f = await api.footer(path).catch(() => null);
        dir = f?.cwd || undefined;
      }
      if (!dir) {
        setStatus(null);
        return;
      }
      setStatus(await api.git(dir));
    } finally {
      setLoading(false);
    }
  }, [path, cwd]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !status) {
    return <div className="p-4 text-sm text-muted-foreground">{t("git.loading")}</div>;
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
              <CommitRow key={cm.hash} commit={cm} isLast={i === status.commits.length - 1} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
