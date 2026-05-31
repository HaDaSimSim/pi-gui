import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import { RefreshCw, Settings, PanelLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { usePanelRef } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { api, type DirectoryInfo, type SessionInfo } from "./api";
import { SessionTab } from "./session-tab";
import { Sidebar, sessionLabel } from "./sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useT } from "./i18n";

// 설정 모달은 열 때만 필요 — lazy 로 분리해 초기 번들에서 제외.
const SettingsModal = lazy(() =>
  import("./settings-modal").then((m) => ({ default: m.SettingsModal })),
);

interface OpenTab {
  path: string;
  label: string;
  cwd?: string; // pending 세션이면 최초 프롬프트에 쓰일 cwd
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
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | undefined>();

  const loadDirs = useCallback(() => {
    setDirsLoading(true);
    api
      .directories()
      .then(setDirs)
      .catch(console.error)
      .finally(() => setDirsLoading(false));
  }, []);
  useEffect(loadDirs, [loadDirs]);

  // 디렉터리의 세션 목록 lazy 로드 (한 번만)
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
      setTabs((prev) => (prev.find((tab) => tab.path === s.path) ? prev : [...prev, { path: s.path, label: sessionLabel(s, t) }]));
      setActiveTab(s.path);
    },
    [t],
  );

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const remaining = prev.filter((tab) => tab.path !== path);
      setActiveTab((cur) => (cur !== path ? cur : remaining.length ? remaining[remaining.length - 1].path : undefined));
      return remaining;
    });
    api.dispose(path).catch(() => undefined); // 닫을 때 런타임 내려달라고 신호 (best-effort)
  }, []);

  const refresh = useCallback(() => {
    setSessionsByDir({});
    setSelectedDir(null);
    loadDirs();
  }, [loadDirs]);

  // 세션이 이름을 알려오면 해당 탭 label 갱신 (이름이 실제로 바뀌었을 때만).
  const setTabTitle = useCallback((path: string, name: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.path === path && tab.label !== name ? { ...tab, label: name } : tab)),
    );
  }, []);

  // 브라우저 탭 제목: 기본 π, 세션 열릴 면 "π · 세션이름".
  useEffect(() => {
    const active = tabs.find((tab) => tab.path === activeTab);
    document.title = active ? `π · ${active.label}` : "π";
  }, [tabs, activeTab]);

  // 새 세션 만들기: cwd 에서 경로 발급 → pending 탭 열기. 첫 프롬프트에 실제 생성.
  const newSession = useCallback(
    async (cwd: string) => {
      try {
        const r = await api.newSession(cwd);
        setTabs((prev) => [...prev, { path: r.path, label: t("sessions.newSession"), cwd }]);
        setActiveTab(r.path);
      } catch (e) {
        console.error(e);
      }
    },
    [t],
  );

  // 새 디렉터리: 경로를 입력받아 그 cwd 에서 새 세션을 시작.
  const newDirectory = useCallback(() => {
    const cwd = window.prompt(t("sessions.newDirectoryPrompt"));
    if (cwd && cwd.trim()) newSession(cwd.trim());
  }, [newSession, t]);

  // 세션 삭제: 확인 → API → 열린 탭 닫기 + 목록 갱신.
  const deleteSession = useCallback(
    async (s: SessionInfo) => {
      if (!window.confirm(t("sessions.deleteConfirm"))) return;
      try {
        const res = await api.deleteSession(s.path);
        if (!res.ok) {
          console.error("delete failed", await res.json().catch(() => null));
          return;
        }
        closeTab(s.path);
        setSessionsByDir((m) => {
          const next = { ...m };
          for (const cwd of Object.keys(next)) next[cwd] = next[cwd].filter((x) => x.path !== s.path);
          return next;
        });
      } catch (e) {
        console.error(e);
      }
    },
    [t, closeTab],
  );

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup>
        {/* 사이드바 — 접기/리사이즈 가능. 기본 22%, 최소 12%. */}
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
                sessions={selectedDir ? sessionsByDir[selectedDir] : undefined}
                sessionsLoading={selectedDir ? loadingDirs.has(selectedDir) : false}
                activeSessionPath={activeTab}
                onOpenSession={openSession}
                onNewSession={newSession}
                onNewDirectory={newDirectory}
                onDeleteSession={deleteSession}
              />
            </div>
            {/* 사이드바 하단 바 */}
            <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border bg-sidebar p-2">
              <span className="flex-1 px-1 font-mono text-xs font-semibold text-muted-foreground">{t("app.title")}</span>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("sessions.refresh")} onClick={refresh}>
                <RefreshCw className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("nav.settings")} onClick={() => setSettingsOpen(true)}>
                <Settings className="size-4" />
              </Button>
            </div>
          </aside>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* 메인 */}
        <ResizablePanel className="min-w-0">
          <main className="flex h-full min-h-0 min-w-0 flex-col">
            {tabs.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={toggleSidebar}>
                  <PanelLeft className="size-4" /> {t("sessions.directories")}
                </Button>
                {t("sessions.emptyHint")}
              </div>
            ) : (
              <>
                {/* 탭 스트립 (토글 버튼 포함) */}
                <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-1">
                  <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="toggle sidebar" onClick={toggleSidebar}>
                    <PanelLeft className="size-4" />
                  </Button>
                  {tabs.map((tab) => {
                    const active = tab.path === activeTab;
                    return (
                      <div
                        key={tab.path}
                        className={cn(
                          "group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                          active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => setActiveTab(tab.path)}
                      >
                        <span className="max-w-[180px] truncate">{tab.label}</span>
                        <button
                          aria-label={t("sessions.closeSession")}
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
                </div>

                {/* 탭 본문 — 모든 탭을 마운트 유지하고 활성만 표시 (SSE 구독 유지) */}
                <div className="min-h-0 flex-1">
                  {tabs.map((tab) => (
                    <div key={tab.path} className={cn("h-full", tab.path === activeTab ? "block" : "hidden")}>
                      <SessionTab path={tab.path} cwd={tab.cwd} onTitle={(name) => setTabTitle(tab.path, name)} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsModal visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} />
        </Suspense>
      ) : null}

      <Toaster position="bottom-right" />
    </div>
  );
}
