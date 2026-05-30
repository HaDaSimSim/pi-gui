import { useCallback, useEffect, useState } from "react";
import Modal from "@cloudscape-design/components/modal";
import Header from "@cloudscape-design/components/header";
import Container from "@cloudscape-design/components/container";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import RadioGroup from "@cloudscape-design/components/radio-group";
import Toggle from "@cloudscape-design/components/toggle";
import Input from "@cloudscape-design/components/input";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Badge from "@cloudscape-design/components/badge";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { Density } from "@cloudscape-design/global-styles";
import { useUiSettings, FONT_DEFAULTS, type ThemeMode } from "./useUiSettings";
import { useT, type Lang } from "./i18n";
import { api, type ModelInfo, type LockRecord } from "./api";

interface LiveRow {
  key: string;
  cwd: string;
  streaming: boolean;
  lockMine: boolean;
}

// owner 표시는 i18n 하지 않고 영어 고정 (요청).
function ownerLabel(owner: string): string {
  if (owner === "pi-web") return "pi-web";
  if (owner === "pi") return "pi (TUI/CLI)";
  return owner || "unknown";
}

export function SettingsModal({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const { settings, update } = useUiSettings();
  const { t } = useT();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [locks, setLocks] = useState<LockRecord[] | null>(null);
  const [live, setLive] = useState<LiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadServer = useCallback(() => {
    setError(null);
    api.models().then(setModels).catch((e) => setError(String(e)));
    api.locks().then(setLocks).catch((e) => setError(String(e)));
    api.live().then(setLive).catch((e) => setError(String(e)));
  }, []);

  // 모달이 열릴 때만 서버 상태를 읽는다.
  useEffect(() => {
    if (visible) loadServer();
  }, [visible, loadServer]);

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="large"
      header={<Header variant="h2" description={t("settings.description")}>{t("settings.heading")}</Header>}
      footer={
        <Box float="right">
          <Button variant="primary" onClick={onDismiss}>
            {t("settings.close")}
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {/* ── 외관 ── */}
        <Container header={<Header variant="h3" description={t("settings.appearanceDesc")}>{t("settings.appearance")}</Header>}>
          <SpaceBetween size="l">
            <FormField label={t("settings.language")} description={t("settings.languageDesc")}>
              <RadioGroup
                value={settings.lang}
                onChange={({ detail }) => update({ lang: detail.value as Lang })}
                items={[
                  { value: "en", label: "English" },
                  { value: "ko", label: "한국어" },
                ]}
              />
            </FormField>

            <FormField label={t("settings.theme")} description={t("settings.themeDesc")}>
              <RadioGroup
                value={settings.theme}
                onChange={({ detail }) => update({ theme: detail.value as ThemeMode })}
                items={[
                  { value: "light", label: t("settings.light") },
                  { value: "dark", label: t("settings.dark") },
                  { value: "true-dark", label: t("settings.trueDark"), description: t("settings.trueDarkDesc") },
                ]}
              />
            </FormField>

            <FormField label={t("settings.density")} description={t("settings.densityDesc")}>
              <RadioGroup
                value={settings.density}
                onChange={({ detail }) => update({ density: detail.value as Density })}
                items={[
                  { value: Density.Comfortable, label: t("settings.comfortable") },
                  { value: Density.Compact, label: t("settings.compact") },
                ]}
              />
            </FormField>

            <FormField label={t("settings.motion")} description={t("settings.motionDesc")}>
              <Toggle checked={settings.motionDisabled} onChange={({ detail }) => update({ motionDisabled: detail.checked })}>
                {t("settings.reduceMotion")}
              </Toggle>
            </FormField>
          </SpaceBetween>
        </Container>

        {/* ── 폰트 (configurable) ── */}
        <Container header={<Header variant="h3">{t("settings.fonts")}</Header>}>
          <SpaceBetween size="l">
            <FormField label={t("settings.fontSans")} description={t("settings.fontSansDesc")}>
              <SpaceBetween size="xs" direction="horizontal">
                <div style={{ minWidth: 420, flex: 1 }}>
                  <Input
                    value={settings.fontSans}
                    onChange={({ detail }) => update({ fontSans: detail.value })}
                  />
                </div>
                <Button onClick={() => update({ fontSans: FONT_DEFAULTS.sans })}>
                  {t("settings.resetDefault")}
                </Button>
              </SpaceBetween>
            </FormField>

            <FormField label={t("settings.fontMono")} description={t("settings.fontMonoDesc")}>
              <SpaceBetween size="xs" direction="horizontal">
                <div style={{ minWidth: 420, flex: 1 }}>
                  <Input
                    value={settings.fontMono}
                    onChange={({ detail }) => update({ fontMono: detail.value })}
                  />
                </div>
                <Button onClick={() => update({ fontMono: FONT_DEFAULTS.mono })}>
                  {t("settings.resetDefault")}
                </Button>
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Container>

        {/* ── 모델 (읽기 전용) ── */}
        <Container
          header={
            <Header variant="h3" counter={models ? `(${models.length})` : undefined} description={t("settings.modelsDesc")}>
              {t("settings.models")}
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={models ?? []}
            loading={models === null && !error}
            loadingText={t("settings.loadingModels")}
            empty={<Box textAlign="center" color="text-status-inactive">{t("settings.noModels")}</Box>}
            columnDefinitions={[
              { id: "provider", header: t("settings.colProvider"), cell: (m) => m.provider, width: 140 },
              { id: "name", header: t("settings.colName"), cell: (m) => m.name, width: 220 },
              { id: "id", header: t("settings.colId"), cell: (m) => <Box variant="code">{m.id}</Box> },
            ]}
          />
        </Container>

        {/* ── 활성 락 (owner 는 영어 고정) ── */}
        <Container
          header={
            <Header variant="h3" counter={locks ? `(${locks.length})` : undefined} description={t("settings.locksDesc")}>
              {t("settings.locks")}
            </Header>
          }
        >
          <Table
            variant="embedded"
            wrapLines
            items={locks ?? []}
            loading={locks === null && !error}
            loadingText={t("settings.loadingLocks")}
            empty={<Box textAlign="center" color="text-status-inactive">{t("settings.noLocks")}</Box>}
            columnDefinitions={[
              {
                id: "owner",
                header: t("settings.colOwner"),
                minWidth: 150,
                width: 170,
                cell: (l) => <Badge color={l.owner === "pi-web" ? "blue" : "grey"}>{ownerLabel(l.owner)}</Badge>,
              },
              { id: "label", header: t("settings.colLabel"), cell: (l) => l.label || "—", width: 180 },
              { id: "pid", header: t("settings.colPid"), cell: (l) => l.pid, width: 90 },
              { id: "session", header: t("settings.colSession"), cell: (l) => <Box variant="code">{l.sessionPath}</Box> },
            ]}
          />
        </Container>

        {/* ── 라이브 런타임 ── */}
        <Container
          header={
            <Header variant="h3" counter={live ? `(${live.length})` : undefined} description={t("settings.liveDesc")}>
              {t("settings.live")}
            </Header>
          }
        >
          <Table
            variant="embedded"
            wrapLines
            items={live ?? []}
            loading={live === null && !error}
            loadingText={t("settings.loadingLive")}
            empty={<Box textAlign="center" color="text-status-inactive">{t("settings.noLive")}</Box>}
            columnDefinitions={[
              { id: "cwd", header: t("settings.colDirectory"), cell: (r) => r.cwd },
              {
                id: "streaming",
                header: t("settings.colStatus"),
                minWidth: 130,
                width: 140,
                cell: (r) =>
                  r.streaming ? (
                    <StatusIndicator type="loading">{t("settings.statusStreaming")}</StatusIndicator>
                  ) : (
                    <StatusIndicator type="success">{t("settings.statusIdle")}</StatusIndicator>
                  ),
              },
              {
                id: "lockMine",
                header: t("settings.colLock"),
                minWidth: 110,
                width: 120,
                cell: (r) =>
                  r.lockMine ? (
                    <StatusIndicator type="success">{t("settings.lockHeld")}</StatusIndicator>
                  ) : (
                    <StatusIndicator type="warning">{t("settings.lockLost")}</StatusIndicator>
                  ),
              },
              { id: "key", header: t("settings.colSession"), cell: (r) => <Box variant="code">{r.key}</Box> },
            ]}
          />
        </Container>

        {error ? <Box color="text-status-error">{t("settings.loadError", { error })}</Box> : null}
      </SpaceBetween>
    </Modal>
  );
}
