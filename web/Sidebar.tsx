// 사이드바 — opencode 웹 스타일의 2-레벨 드릴다운 네비게이션.
//
// 레벨 1: 디렉터리 목록. 클릭하면 "펼침"이 아니라 그 디렉터리 안으로 들어간다.
// 레벨 2: 뒤로가기 헤더 + 해당 디렉터리의 세션 목록. 세션 클릭 → 탭으로 열림.
//
// (인라인 expandable-link-group 대신 드릴다운이라, 디렉터리는 내가 들어가기
//  전에는 절대 열리지 않는다.)

import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Badge from "@cloudscape-design/components/badge";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { DirectoryInfo, SessionInfo } from "./api";
import type { TFunc } from "./i18n";

function shortCwd(cwd: string): string {
  return cwd.split("/").slice(-2).join("/") || cwd;
}

export function sessionLabel(s: SessionInfo, t: TFunc): string {
  return s.name || s.firstMessage?.slice(0, 40) || t("sessions.untitled");
}

// 클릭 가능한 행 — 좌측 콘텐츠 + 우측 보조(badge 등). 키보드 접근 가능.
function Row(props: {
  onClick: () => void;
  selected?: boolean;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        background: props.selected ? "var(--color-background-item-selected, rgba(0,115,255,0.1))" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!props.selected) e.currentTarget.style.background = "var(--color-background-dropdown-item-hover, rgba(0,0,0,0.06))";
      }}
      onMouseLeave={(e) => {
        if (!props.selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{props.children}</div>
      {props.trailing ? <div style={{ flexShrink: 0 }}>{props.trailing}</div> : null}
    </div>
  );
}

export interface SidebarProps {
  t: TFunc;
  dirs: DirectoryInfo[];
  dirsLoading: boolean;
  // 드릴다운 상태: 선택된 디렉터리(없으면 레벨 1)
  selectedDir: string | null;
  onSelectDir: (cwd: string | null) => void;
  sessions: SessionInfo[] | undefined; // 선택된 디렉터리의 세션 (로딩 중이면 undefined)
  sessionsLoading: boolean;
  activeSessionPath: string | undefined;
  onOpenSession: (s: SessionInfo) => void;
}

export function Sidebar(props: SidebarProps) {
  const { t } = props;

  // ── 레벨 2: 디렉터리 안 (세션 목록) ──
  if (props.selectedDir) {
    const sessions = props.sessions;
    return (
      <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
        <Button variant="link" iconName="angle-left" onClick={() => props.onSelectDir(null)}>
          {t("sessions.directories")}
        </Button>
        <Box variant="h3" padding={{ horizontal: "s", vertical: "xs" }}>
          <span title={props.selectedDir}>{shortCwd(props.selectedDir)}</span>
        </Box>

        {props.sessionsLoading || !sessions ? (
          <Box textAlign="center" padding="m" color="text-status-inactive">
            <Spinner /> {t("sessions.loadingSessions")}
          </Box>
        ) : sessions.length === 0 ? (
          <Box textAlign="center" padding="m" color="text-status-inactive">
            {t("sessions.noSessions")}
          </Box>
        ) : (
          sessions.map((s) => (
            <Row
              key={s.path}
              onClick={() => props.onOpenSession(s)}
              selected={s.path === props.activeSessionPath}
              ariaLabel={sessionLabel(s, t)}
              trailing={s.live ? <StatusIndicator type="success">{t("sessions.live")}</StatusIndicator> : undefined}
            >
              <Box
                fontWeight={s.path === props.activeSessionPath ? "bold" : "normal"}
                color="inherit"
              >
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {sessionLabel(s, t)}
                </span>
              </Box>
            </Row>
          ))
        )}
      </div>
    );
  }

  // ── 레벨 1: 디렉터리 목록 ──
  return (
    <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
      <Box variant="h3" padding={{ horizontal: "s", vertical: "xs" }}>
        {t("sessions.directories")}
      </Box>

      {props.dirsLoading ? (
        <Box textAlign="center" padding="m" color="text-status-inactive">
          <Spinner /> {t("sessions.loadingDirectories")}
        </Box>
      ) : props.dirs.length === 0 ? (
        <Box textAlign="center" padding="m" color="text-status-inactive">
          {t("sessions.noDirectories")}
        </Box>
      ) : (
        props.dirs.map((d) => (
          <Row
            key={d.cwd}
            onClick={() => props.onSelectDir(d.cwd)}
            ariaLabel={d.cwd}
            trailing={<Badge>{d.sessionCount}</Badge>}
          >
            <span
              title={d.cwd}
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortCwd(d.cwd)}
            </span>
          </Row>
        ))
      )}
    </div>
  );
}
