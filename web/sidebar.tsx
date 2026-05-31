// 사이드바 — 2-레벨 드릴다운 네비게이션.
//
// 레벨 1: 디렉터리 목록. 클릭하면 그 디렉터리 안으로 들어간다(인라인 확장 X).
// 레벨 2: 뒤로가기 헤더 + 해당 디렉터리의 세션 목록. 세션 클릭 → 탭으로 열림.

import { ChevronLeft, Loader2, Plus, FolderPlus, Folder, Trash2, Search, Pencil } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DirectoryInfo, SessionInfo } from "./api";
import type { TFunc } from "./i18n";

function shortCwd(cwd: string): string {
  return cwd.split("/").slice(-2).join("/") || cwd;
}

// 경로를 basename 과 부모로 분리 (사이드바 디렉터리 표시용).
function splitPath(cwd: string): { base: string; parent: string } {
  const parts = cwd.replace(/\/$/, "").split("/");
  const base = parts[parts.length - 1] || cwd;
  const parent = parts.slice(0, -1).join("/").replace(/^\/(Users|home)\/[^/]+/, "~");
  return { base, parent };
}

// 상대 시간 (마지막 활동). 짧게.
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

export function sessionLabel(s: SessionInfo, t: TFunc): string {
  return s.name || s.firstMessage?.slice(0, 40) || t("sessions.untitled");
}

export interface SidebarProps {
  t: TFunc;
  dirs: DirectoryInfo[];
  dirsLoading: boolean;
  selectedDir: string | null;
  onSelectDir: (cwd: string | null) => void;
  sessions: SessionInfo[] | undefined;
  sessionsLoading: boolean;
  activeSessionPath: string | undefined;
  onOpenSession: (s: SessionInfo) => void;
  onNewSession: (cwd: string) => void;
  onNewDirectory: () => void;
  onDeleteSession: (s: SessionInfo) => void;
  onRenameSession: (s: SessionInfo) => void;
}

// 검색 입력칸 (사이드바 공용). 아이콘 + controlled input.
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { t } = props;
  const [dirQuery, setDirQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");

  // 필터링: 디렉터리는 경로로, 세션은 이름/첫메시지로 (대소문자 무시).
  const dq = dirQuery.trim().toLowerCase();
  const filteredDirs = dq ? props.dirs.filter((d) => d.cwd.toLowerCase().includes(dq)) : props.dirs;
  const sq = sessionQuery.trim().toLowerCase();
  const filteredSessions = props.sessions
    ? sq
      ? props.sessions.filter((s) =>
          sessionLabel(s, t).toLowerCase().includes(sq) || (s.firstMessage ?? "").toLowerCase().includes(sq),
        )
      : props.sessions
    : undefined;

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {props.selectedDir ? (
        // ── 레벨 2: 세션 목록 ──
        <>
          <div className="flex flex-col gap-1 border-b border-sidebar-border p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-fit justify-start gap-1 px-2 text-muted-foreground"
              onClick={() => props.onSelectDir(null)}
            >
              <ChevronLeft className="size-3.5" />
              {t("sessions.directories")}
            </Button>
            <div className="flex items-center justify-between gap-2">
              <div className="truncate px-2 text-sm font-semibold" title={props.selectedDir}>
                {shortCwd(props.selectedDir)}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={t("sessions.newSession")}
                title={t("sessions.newSession")}
                onClick={() => props.onNewSession(props.selectedDir!)}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <SearchBox value={sessionQuery} onChange={setSessionQuery} placeholder={t("sessions.searchSessions")} />
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {props.sessionsLoading || !filteredSessions ? (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t("sessions.loadingSessions")}
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {sessionQuery.trim() ? t("sessions.noMatch") : t("sessions.noSessions")}
                </div>
              ) : (
                filteredSessions.map((s) => {
                  const active = s.path === props.activeSessionPath;
                  return (
                    <div
                      key={s.path}
                      className={cn(
                        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
                        active && "bg-sidebar-accent font-medium",
                      )}
                    >
                      <button onClick={() => props.onOpenSession(s)} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left">
                        <span className="truncate">{s.draft ? t("sessions.newSession") : sessionLabel(s, t)}</span>
                        {s.draft ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">{t("sessions.draft")}</span>
                        ) : null}
                      </button>
                      {s.live ? <span className="size-2 shrink-0 rounded-full bg-emerald-500" title={t("sessions.live")} /> : null}
                      {s.draft ? null : (
                      <>
                      <button
                        aria-label={t("info.rename")}
                        title={t("info.rename")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                        onClick={() => props.onRenameSession(s)}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        aria-label={t("sessions.delete")}
                        title={t("sessions.delete")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        onClick={() => props.onDeleteSession(s)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                      </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </>
      ) : (
        // ── 레벨 1: 디렉터리 목록 ──
        <>
          <div className="flex flex-col gap-2 border-b border-sidebar-border p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">{t("sessions.directories")}</div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("sessions.newDirectory")}
                title={t("sessions.newDirectory")}
                onClick={props.onNewDirectory}
              >
                <FolderPlus className="size-4" />
              </Button>
            </div>
            <SearchBox value={dirQuery} onChange={setDirQuery} placeholder={t("sessions.searchDirectories")} />
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {props.dirsLoading ? (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t("sessions.loadingDirectories")}
                </div>
              ) : filteredDirs.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {dirQuery.trim() ? t("sessions.noMatch") : t("sessions.noDirectories")}
                </div>
              ) : (
                filteredDirs.map((d) => {
                  const { base, parent } = splitPath(d.cwd);
                  return (
                    <button
                      key={d.cwd}
                      onClick={() => props.onSelectDir(d.cwd)}
                      title={d.cwd}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{base}</span>
                        {parent ? <span className="truncate text-[11px] text-muted-foreground">{parent}</span> : null}
                      </span>
                      {d.lastModified ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(d.lastModified)}</span>
                      ) : null}
                      <Badge variant="secondary" className="shrink-0">
                        {d.sessionCount}
                      </Badge>
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
