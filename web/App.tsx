import { useCallback, useEffect, useState } from "react";
import AppLayout from "@cloudscape-design/components/app-layout";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import Tabs from "@cloudscape-design/components/tabs";
import Box from "@cloudscape-design/components/box";
import { api, type DirectoryInfo, type SessionInfo } from "./api";
import { SessionTab } from "./SessionTab";
import { Sidebar, sessionLabel } from "./Sidebar";
import { SettingsModal } from "./SettingsModal";
import { useT } from "./i18n";

interface OpenTab {
  path: string;
  label: string;
}

export default function App() {
  const { t } = useT();
  const [navOpen, setNavOpen] = useState(true);
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
      setTabs((prev) =>
        prev.find((tab) => tab.path === s.path) ? prev : [...prev, { path: s.path, label: sessionLabel(s, t) }],
      );
      setActiveTab(s.path);
    },
    [t],
  );

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const remaining = prev.filter((tab) => tab.path !== path);
      setActiveTab((cur) =>
        cur !== path ? cur : remaining.length ? remaining[remaining.length - 1].path : undefined,
      );
      return remaining;
    });
    api.dispose(path).catch(() => undefined); // 닫을 때 런타임 내려달라고 신호 (best-effort)
  }, []);

  const refresh = useCallback(() => {
    setSessionsByDir({});
    setSelectedDir(null);
    loadDirs();
  }, [loadDirs]);

  return (
    <>
      {/* 아주 얇은 상단 바. <header> 로 감싸야 AppLayout 의 headerSelector="header" 가
          이 높이를 측정해 콘텐츠 영역을 올바르게 잡는다 (안 감싸면 페이지 스크롤 발생). */}
      <header>
        <TopNavigation
          identity={{ href: "#", title: t("app.title"), onFollow: (e) => e.preventDefault() }}
          utilities={[
            {
              type: "button",
              iconName: "refresh",
              ariaLabel: t("sessions.refresh"),
              title: t("sessions.refresh"),
              onClick: refresh,
            },
            {
              type: "button",
              iconName: "settings",
              text: t("nav.settings"),
              ariaLabel: t("nav.settings"),
              onClick: () => setSettingsOpen(true),
            },
          ]}
        />
      </header>

      <AppLayout
        headerSelector="header"
        navigationOpen={navOpen}
        onNavigationChange={({ detail }) => setNavOpen(detail.open)}
        toolsHide
        navigation={
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
          />
        }
        disableContentPaddings
        content={
          tabs.length === 0 ? (
            <Box color="text-status-inactive" textAlign="center" padding="xxl">
              {t("sessions.emptyHint")}
            </Box>
          ) : (
            <Tabs
              activeTabId={activeTab}
              onChange={({ detail }) => setActiveTab(detail.activeTabId)}
              variant="default"
              tabs={tabs.map((tab) => ({
                id: tab.path,
                label: tab.label,
                dismissible: true,
                dismissLabel: t("sessions.closeSession"),
                onDismiss: () => closeTab(tab.path),
                content: <SessionTab path={tab.path} />,
              }))}
            />
          )
        }
      />

      <SettingsModal visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} />
    </>
  );
}
