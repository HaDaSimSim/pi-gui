// Sidebar — 2-level drill-down navigation.
//
// Level 1: directory list. Clicking enters that directory (no inline expansion).
// Level 2: back header + that directory's session list. Clicking a session → opens it in a tab.

import {
  Check,
  ChevronLeft,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { DirectoryInfo, SessionInfo } from './api';
import type { TFunc } from './i18n';

function shortCwd(cwd: string): string {
  return cwd.split('/').slice(-2).join('/') || cwd;
}

// Split a path into basename and parent (for sidebar directory display).
function splitPath(cwd: string): { base: string; parent: string } {
  const parts = cwd.replace(/\/$/, '').split('/');
  const base = parts[parts.length - 1] || cwd;
  const parent = parts
    .slice(0, -1)
    .join('/')
    .replace(/^\/(Users|home)\/[^/]+/, '~');
  return { base, parent };
}

// Relative time (last activity). Kept short.
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

export function sessionLabel(s: SessionInfo, t: TFunc): string {
  return s.name || s.firstMessage?.slice(0, 40) || t('sessions.untitled');
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
  onDiscardDraft: (s: SessionInfo) => void;
}

// Search input (shared by the sidebar). Icon + controlled input.
function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
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
  const [dirQuery, setDirQuery] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  // Delete double-check: the first click enters confirm mode (check/X), the second check actually deletes.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Filtering: directories by path, sessions by name/first message (case-insensitive).
  const dq = dirQuery.trim().toLowerCase();
  const filteredDirs = dq ? props.dirs.filter((d) => d.cwd.toLowerCase().includes(dq)) : props.dirs;
  const sq = sessionQuery.trim().toLowerCase();
  const filteredSessions = props.sessions
    ? sq
      ? props.sessions.filter(
          (s) =>
            sessionLabel(s, t).toLowerCase().includes(sq) ||
            (s.firstMessage ?? '').toLowerCase().includes(sq),
        )
      : props.sessions
    : undefined;

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {props.selectedDir ? (
        // ── Level 2: session list ──
        <>
          <div className="flex flex-col gap-1 border-b border-sidebar-border p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-fit justify-start gap-1 px-2 text-muted-foreground"
              onClick={() => props.onSelectDir(null)}
            >
              <ChevronLeft className="size-3.5" />
              {t('sessions.directories')}
            </Button>
            <div className="flex items-center justify-between gap-2">
              <div className="truncate px-2 text-sm font-semibold" title={props.selectedDir}>
                {shortCwd(props.selectedDir)}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={t('sessions.newSession')}
                title={t('sessions.newSession')}
                onClick={() => props.onNewSession(props.selectedDir!)}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <SearchBox
              value={sessionQuery}
              onChange={setSessionQuery}
              placeholder={t('sessions.searchSessions')}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {props.sessionsLoading || !filteredSessions ? (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t('sessions.loadingSessions')}
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {sessionQuery.trim() ? t('sessions.noMatch') : t('sessions.noSessions')}
                </div>
              ) : (
                filteredSessions.map((s) => {
                  const active = s.path === props.activeSessionPath;
                  return (
                    <div
                      key={s.path}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                        active
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/80',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => props.onOpenSession(s)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                      >
                        <span className="truncate">{sessionLabel(s, t)}</span>
                        {s.draft ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                            {t('sessions.draft')}
                          </span>
                        ) : null}
                      </button>
                      {s.live ? (
                        <span
                          className="size-2 shrink-0 rounded-full bg-emerald-500"
                          title={t('sessions.live')}
                        />
                      ) : null}
                      {s.draft ? (
                        // draft: no file/lock, so just close it (remove the tab). Always show X.
                        <button
                          type="button"
                          aria-label={t('sessions.closeSession')}
                          title={t('sessions.closeSession')}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onDiscardDraft(s);
                          }}
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : confirmDelete === s.path ? (
                        // Delete double-check: check (confirm) / X (cancel)
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            aria-label={t('sessions.confirmDelete')}
                            title={t('sessions.confirmDelete')}
                            className="rounded p-0.5 text-destructive hover:bg-destructive/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(null);
                              props.onDeleteSession(s);
                            }}
                          >
                            <Check className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('info.cancel')}
                            title={t('info.cancel')}
                            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(null);
                            }}
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      ) : (
                        <>
                          {/* Normal: last activity time (always if active, otherwise only when not hovering) */}
                          {s.modified ? (
                            <span
                              className={cn(
                                'shrink-0 text-[11px] text-muted-foreground',
                                active ? '' : 'group-hover:hidden',
                              )}
                            >
                              {relativeTime(s.modified)}
                            </span>
                          ) : null}
                          {/* Edit/delete: shown on hover or when active */}
                          <span
                            className={cn(
                              'flex shrink-0 items-center gap-0.5',
                              active ? '' : 'hidden group-hover:flex',
                            )}
                          >
                            <button
                              type="button"
                              aria-label={t('info.rename')}
                              title={t('info.rename')}
                              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onRenameSession(s);
                              }}
                            >
                              <Pencil className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label={t('sessions.delete')}
                              title={t('sessions.delete')}
                              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDelete(s.path);
                              }}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </span>
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
        // ── Level 1: directory list ──
        <>
          <div className="flex flex-col gap-2 border-b border-sidebar-border p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">{t('sessions.directories')}</div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('sessions.newDirectory')}
                title={t('sessions.newDirectory')}
                onClick={props.onNewDirectory}
              >
                <FolderPlus className="size-4" />
              </Button>
            </div>
            <SearchBox
              value={dirQuery}
              onChange={setDirQuery}
              placeholder={t('sessions.searchDirectories')}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {props.dirsLoading ? (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t('sessions.loadingDirectories')}
                </div>
              ) : filteredDirs.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  {dirQuery.trim() ? t('sessions.noMatch') : t('sessions.noDirectories')}
                </div>
              ) : (
                filteredDirs.map((d) => {
                  const { base, parent } = splitPath(d.cwd);
                  return (
                    <button
                      type="button"
                      key={d.cwd}
                      onClick={() => props.onSelectDir(d.cwd)}
                      title={d.cwd}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{base}</span>
                        {parent ? (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {parent}
                          </span>
                        ) : null}
                      </span>
                      {d.lastModified ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {relativeTime(d.lastModified)}
                        </span>
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
