import { MoreHorizontal, PanelLeft, RefreshCw, Settings, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { api, type DirectoryInfo, type SessionInfo } from './api';
import { IS_TAURI } from './config';
import { DirectoryPicker } from './directory-picker';
import { useT } from './i18n';
import { LogViewer } from './log-viewer';
import { SessionTab } from './session-tab';
import { Sidebar, sessionLabel } from './sidebar';
import { Titlebar } from './titlebar';

// The settings modal is only needed when opened — split out via lazy to exclude it from the initial bundle.
const SettingsModal = lazy(() =>
  import('./settings-modal').then((m) => ({ default: m.SettingsModal })),
);

interface OpenTab {
  path: string;
  label: string;
  cwd?: string; // for a pending session, the cwd to use for the first prompt
}

export default function App() {
  const { t } = useT();
  const sidebarRef = usePanelRef();
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, [sidebarRef]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dirs, setDirs] = useState<DirectoryInfo[]>([]);
  const [dirsLoading, setDirsLoading] = useState(true);
  const [sessionsByDir, setSessionsByDir] = useState<Record<string, SessionInfo[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // Persist open tabs/active tab to localStorage — restore even after closing and reopening the app.
  const TABS_KEY = 'pi-gui.open-tabs';
  const [tabs, setTabs] = useState<OpenTab[]>(() => {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      return raw ? (JSON.parse(raw).tabs ?? []) : [];
    } catch {
      return [];
    }
  });
  const [logOpen, setLogOpen] = useState(false);

  // Cmd+Shift+L → toggle the backend log viewer.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setLogOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [activeTab, setActiveTab] = useState<string | undefined>(() => {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      return raw ? (JSON.parse(raw).active ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  });

  const loadDirs = useCallback(() => {
    setDirsLoading(true);
    api
      .directories()
      .then(setDirs)
      .catch(console.error)
      .finally(() => setDirsLoading(false));
  }, []);
  useEffect(loadDirs, [loadDirs]);

  // Periodic background polling: refresh the directory list + the currently viewed session list (5s).
  useEffect(() => {
    const id = setInterval(() => {
      api
        .directories()
        .then(setDirs)
        .catch(() => undefined);
      if (selectedDir) {
        api
          .sessions(selectedDir)
          .then((sessions) => setSessionsByDir((m) => ({ ...m, [selectedDir]: sessions })))
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [selectedDir]);

  // Save to localStorage whenever tabs change (for restore after a full quit and relaunch).
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: activeTab }));
    } catch {
      /* ignore save failures */
    }
  }, [tabs, activeTab]);

  // Re-read a directory's session list. If retry=true, retry a few times to account for file-write delay
  // (right after the first prompt the jsonl may not be written yet, so the draft isn't cleared).
  const refreshDirSessions = useCallback((dir?: string, retry = false) => {
    if (!dir) return;
    let attempts = retry ? 4 : 1;
    const run = () => {
      api
        .sessions(dir)
        .then((sessions) => {
          setSessionsByDir((m) => ({ ...m, [dir]: sessions }));
          attempts -= 1;
          if (retry && attempts > 0) setTimeout(run, 600);
        })
        .catch(() => undefined);
    };
    run();
  }, []);

  // Lazy-load a directory's session list (once only)
  const ensureSessions = useCallback(
    (cwd: string) => {
      if (sessionsByDir[cwd]) return;
      setLoadingDirs((s) => new Set(s).add(cwd));
      api
        .sessions(cwd)
        .then((sessions) => setSessionsByDir((m) => ({ ...m, [cwd]: sessions })))
        .catch(console.error)
        .finally(() =>
          setLoadingDirs((s) => {
            const n = new Set(s);
            n.delete(cwd);
            return n;
          }),
        );
    },
    [sessionsByDir],
  );

  const selectDir = useCallback(
    (cwd: string | null) => {
      setSelectedDir(cwd);
      if (cwd) ensureSessions(cwd);
    },
    [ensureSessions],
  );

  const openSession = useCallback(
    (s: SessionInfo) => {
      setTabs((prev) =>
        prev.find((tab) => tab.path === s.path)
          ? prev
          : [...prev, { path: s.path, label: sessionLabel(s, t), cwd: selectedDir ?? undefined }],
      );
      setActiveTab(s.path);
    },
    [t, selectedDir],
  );

  const closeTab = useCallback(
    async (path: string) => {
      // If the session is running (streaming), confirm before aborting and closing.
      try {
        const live = await api.live();
        const running = live.find((r) => r.key === path && r.streaming);
        if (running && !window.confirm(t('tabs.closeRunningConfirm'))) return;
        if (running) await api.abort(path).catch(() => undefined);
      } catch {
        /* proceed with closing even if the live lookup fails */
      }
      setTabs((prev) => {
        const remaining = prev.filter((tab) => tab.path !== path);
        setActiveTab((cur) =>
          cur !== path ? cur : remaining.length ? remaining[remaining.length - 1].path : undefined,
        );
        return remaining;
      });
      api.dispose(path).catch(() => undefined); // signal to tear down the runtime on close (best-effort)
    },
    [t],
  );

  // Close all tabs. Tear down each tab's runtime best-effort too.
  const closeAllTabs = useCallback(() => {
    setTabs((prev) => {
      for (const tab of prev) api.dispose(tab.path).catch(() => undefined);
      return [];
    });
    setActiveTab(undefined);
  }, []);

  const refresh = useCallback(() => {
    setSessionsByDir({});
    setSelectedDir(null);
    loadDirs();
  }, [loadDirs]);

  // When a session reports its name, update that tab's label (only if the name actually changed).
  // At the same time, force-refresh the sidebar list for the cwd that session belongs to
  // (a new pending session only appears in the list once the first prompt creates its file).
  const setTabTitle = useCallback(
    (path: string, name: string) => {
      let cwd: string | undefined;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.path === path) cwd = tab.cwd;
          return tab.path === path && tab.label !== name ? { ...tab, label: name } : tab;
        }),
      );
      if (cwd) {
        api
          .sessions(cwd)
          .then((sessions) => setSessionsByDir((m) => ({ ...m, [cwd!]: sessions })))
          .catch(() => undefined);
        loadDirs();
      }
    },
    [loadDirs],
  );

  // Title format: π - session name - directory (last segment).
  // If there's no session name, untitled; if no directory, omit it.
  const activeTab_ = tabs.find((tab) => tab.path === activeTab);
  const docTitle = (() => {
    if (!activeTab_) return 'π';
    const name = activeTab_.label || t('sessions.untitled');
    const dir = activeTab_.cwd ? activeTab_.cwd.replace(/\/$/, '').split('/').pop() : '';
    return dir ? `π - ${name} - ${dir}` : `π - ${name}`;
  })();
  useEffect(() => {
    document.title = docTitle;
    if (IS_TAURI) {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(docTitle))
        .catch(() => undefined);
    }
  }, [docTitle]);

  // Create a new session: issue a path from cwd → open a pending tab. Actually created on the first prompt.
  const newSession = useCallback(
    async (cwd: string) => {
      try {
        const r = await api.newSession(cwd);
        setTabs((prev) => [...prev, { path: r.path, label: t('sessions.untitled'), cwd }]);
        setActiveTab(r.path);
        // Add it to the sidebar list immediately when the new session is created so the draft tag doesn't show.
        setSessionsByDir((m) => {
          const list = m[cwd] ?? [];
          if (list.find((s) => s.path === r.path)) return m;
          return {
            ...m,
            [cwd]: [
              ...list,
              {
                path: r.path,
                id: '',
                name: null,
                firstMessage: '',
                messageCount: 0,
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                live: false,
              },
            ],
          };
        });
      } catch (e) {
        console.error(e);
      }
    },
    [t],
  );

  // New directory: on Tauri use the native folder picker (returns an absolute path), otherwise the server browse modal.
  const [pickerOpen, setPickerOpen] = useState(false);
  const newDirectory = useCallback(async () => {
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, title: t('picker.title') });
      if (typeof picked === 'string' && picked.trim()) newSession(picked.trim());
      return;
    }
    setPickerOpen(true);
  }, [newSession, t]);

  // Delete session: the sidebar already did an inline double-check, so go straight to API → close tab + refresh list.
  const deleteSession = useCallback(
    async (s: SessionInfo) => {
      try {
        const res = await api.deleteSession(s.path);
        if (!res.ok) {
          console.error('delete failed', await res.json().catch(() => null));
          return;
        }
        closeTab(s.path);
        setSessionsByDir((m) => {
          const next = { ...m };
          for (const cwd of Object.keys(next))
            next[cwd] = next[cwd].filter((x) => x.path !== s.path);
          return next;
        });
      } catch (e) {
        console.error(e);
      }
    },
    [closeTab],
  );

  // Rename a session (sidebar). rename is a write so it requires a runtime — allowed since the user
  // is explicitly changing it. On success, refresh the list/tab label.
  const renameSession = useCallback(
    async (s: SessionInfo) => {
      const next = window.prompt(t('info.renamePlaceholder'), s.name ?? '');
      if (next == null) return;
      const name = next.trim();
      if (!name) return;
      try {
        await api.rename(s.path, name);
        setTabTitle(s.path, name);
        if (selectedDir) {
          api
            .sessions(selectedDir)
            .then((sessions) => setSessionsByDir((m) => ({ ...m, [selectedDir]: sessions })))
            .catch(() => undefined);
        }
      } catch (e) {
        console.error(e);
      }
    },
    [t, setTabTitle, selectedDir],
  );
  // Session list shown in the sidebar: in front of the server-provided list, temporarily place
  // drafts (open pending tabs) that have no file yet. Once the first message creates a file,
  // setTabTitle refreshes the list and they turn into real sessions.
  const sidebarSessions = (() => {
    if (!selectedDir) return undefined;
    const fetched = sessionsByDir[selectedDir];
    if (!fetched) return undefined;
    const known = new Set(fetched.map((s) => s.path));
    const drafts: SessionInfo[] = tabs
      .filter((tab) => tab.cwd === selectedDir && !known.has(tab.path))
      .map((tab) => ({
        path: tab.path,
        id: '',
        name: null,
        firstMessage: '',
        messageCount: 0,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        live: false,
        draft: true,
      }));
    return [...drafts, ...fetched];
  })();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Tauri: top drag strip (reserves space below the macOS traffic lights + window move) */}
      {IS_TAURI ? (
        <Titlebar
          name={activeTab_ ? activeTab_.label || t('sessions.untitled') : ''}
          dir={activeTab_?.cwd ? activeTab_.cwd.replace(/\/$/, '').split('/').pop() : undefined}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup>
          {/* Sidebar — collapsible/resizable. Default 22%, min 12%. */}
          <ResizablePanel
            panelRef={sidebarRef}
            collapsible
            collapsedSize={0}
            minSize="220px"
            defaultSize="300px"
            maxSize="480px"
            className="min-w-0"
          >
            <aside className="flex h-full flex-col border-r">
              <div className="flex min-h-0 flex-1 flex-col">
                <Sidebar
                  t={t}
                  dirs={dirs}
                  dirsLoading={dirsLoading}
                  selectedDir={selectedDir}
                  onSelectDir={selectDir}
                  sessions={sidebarSessions}
                  sessionsLoading={selectedDir ? loadingDirs.has(selectedDir) : false}
                  activeSessionPath={activeTab}
                  onOpenSession={openSession}
                  onNewSession={newSession}
                  onNewDirectory={newDirectory}
                  onDeleteSession={deleteSession}
                  onRenameSession={renameSession}
                  onDiscardDraft={(s) => closeTab(s.path)}
                />
              </div>
              {/* Sidebar bottom bar */}
              <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border bg-sidebar p-2">
                <span className="flex-1 px-1 font-mono text-xs font-semibold text-muted-foreground">
                  {t('app.title')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('sessions.refresh')}
                  onClick={refresh}
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('nav.settings')}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="size-4" />
                </Button>
              </div>
            </aside>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main */}
          <ResizablePanel className="min-w-0">
            <main className="flex h-full min-h-0 min-w-0 flex-col">
              {tabs.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground">
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={toggleSidebar}>
                    <PanelLeft className="size-4" /> {t('sessions.directories')}
                  </Button>
                  {t('sessions.emptyHint')}
                </div>
              ) : (
                <>
                  {/* Tab strip (includes the toggle button, supports drag reorder) */}
                  <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label="toggle sidebar"
                      onClick={toggleSidebar}
                    >
                      <PanelLeft className="size-4" />
                    </Button>
                    {tabs.map((tab, idx) => {
                      const active = tab.path === activeTab;
                      return (
                        <div
                          key={tab.path}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', String(idx));
                            (e.currentTarget as HTMLElement).style.opacity = '0.5';
                          }}
                          onDragEnd={(e) => {
                            (e.currentTarget as HTMLElement).style.opacity = '';
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = Number(e.dataTransfer.getData('text/plain'));
                            const to = idx;
                            if (from === to || Number.isNaN(from)) return;
                            setTabs((prev) => {
                              const next = [...prev];
                              const [moved] = next.splice(from, 1);
                              next.splice(to, 0, moved);
                              return next;
                            });
                          }}
                          className={cn(
                            'group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm select-none',
                            active
                              ? 'border-primary font-medium'
                              : 'border-transparent text-muted-foreground hover:text-foreground',
                          )}
                          role="tab"
                          tabIndex={0}
                          aria-selected={active}
                          onClick={() => setActiveTab(tab.path)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setActiveTab(tab.path);
                            }
                          }}
                        >
                          <span className="max-w-[120px] truncate">{tab.label}</span>
                          <button
                            type="button"
                            aria-label={t('sessions.closeSession')}
                            className="rounded p-0.5 opacity-50 hover:bg-accent hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(tab.path);
                            }}
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                    {/* Tab menu (far right): close all tabs etc. */}
                    <div className="ml-auto shrink-0 pr-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={t('tabs.menu')}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={closeAllTabs}>
                            {t('tabs.closeAll')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Tab body — keep all tabs mounted and show only the active one (keeps SSE subscriptions) */}
                  <div className="min-h-0 flex-1">
                    {tabs.map((tab) => (
                      <div
                        key={tab.path}
                        className={cn('h-full', tab.path === activeTab ? 'block' : 'hidden')}
                      >
                        <SessionTab
                          path={tab.path}
                          cwd={tab.cwd}
                          onTitle={(name) => setTabTitle(tab.path, name)}
                          onLive={() => {
                            refreshDirSessions(tab.cwd, true);
                            loadDirs();
                          }}
                          onLiveChange={() => {
                            refreshDirSessions(tab.cwd);
                            loadDirs();
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsModal visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} />
        </Suspense>
      ) : null}

      <Toaster position="bottom-right" />

      {pickerOpen ? (
        <DirectoryPicker
          onClose={() => setPickerOpen(false)}
          onPick={(dir) => {
            setPickerOpen(false);
            newSession(dir);
          }}
        />
      ) : null}
      <LogViewer open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  );
}
