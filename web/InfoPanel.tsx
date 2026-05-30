// 세션 info 패널 (오른쪽 드로어). opencode 의 context window 패널 감성.
//
// 라이브일 때: 모델 선택, 효율(thinking level), 컨텍스트 사용량 바, raw 통계.
// 세션 이름 변경(rename)도 여기서. 라이브 아니면 안내만.

import { useEffect, useState } from "react";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Select from "@cloudscape-design/components/select";
import type { SelectProps } from "@cloudscape-design/components/select";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import Input from "@cloudscape-design/components/input";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import { api, type ModelInfo, type ThinkingLevel } from "./api";
import { useT } from "./i18n";
import type { SessionState } from "./useSession";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface InfoPanelProps {
  state: SessionState;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onRename: (name: string) => void;
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString();
}

export function InfoPanel({ state, onSetModel, onSetThinking, onRename }: InfoPanelProps) {
  const { t } = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);

  const controls = state.controls;

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined);
  }, []);

  useEffect(() => {
    setNameDraft(controls?.name ?? "");
  }, [controls?.name]);

  if (!state.live || !controls) {
    return (
      <Box padding="l" color="text-status-inactive">
        {t("info.notLive")}
      </Box>
    );
  }

  const modelOptions: SelectProps.Option[] = models.map((m) => ({
    label: m.name,
    value: `${m.provider}/${m.id}`,
    description: `${m.provider} · ${m.id}`,
  }));
  const selectedModel: SelectProps.Option | null = controls.model
    ? {
        label: controls.model.name,
        value: `${controls.model.provider}/${controls.model.id}`,
        description: `${controls.model.provider} · ${controls.model.id}`,
      }
    : null;

  const thinkingOptions: SelectProps.Option[] = (
    controls.availableThinkingLevels.length ? controls.availableThinkingLevels : THINKING_LEVELS
  ).map((l) => ({ label: l, value: l }));
  const selectedThinking: SelectProps.Option | null = controls.thinkingLevel
    ? { label: controls.thinkingLevel, value: controls.thinkingLevel }
    : null;

  const usage = controls.stats?.contextUsage;
  const percent = usage?.percent ?? null;

  return (
    <SpaceBetween size="l">
      {/* 이름 변경 */}
      <FormField label={t("info.rename")}>
        {editingName ? (
          <SpaceBetween size="xs" direction="horizontal">
            <Input
              value={nameDraft}
              onChange={({ detail }) => setNameDraft(detail.value)}
              placeholder={t("info.renamePlaceholder")}
            />
            <Button
              variant="primary"
              onClick={() => {
                onRename(nameDraft.trim());
                setEditingName(false);
              }}
            >
              {t("info.save")}
            </Button>
            <Button onClick={() => setEditingName(false)}>{t("info.cancel")}</Button>
          </SpaceBetween>
        ) : (
          <SpaceBetween size="xs" direction="horizontal">
            <Box variant="strong">{controls.name || t("sessions.untitled")}</Box>
            <Button iconName="edit" variant="inline-icon" ariaLabel={t("info.rename")} onClick={() => setEditingName(true)} />
          </SpaceBetween>
        )}
      </FormField>

      {/* 모델 */}
      <FormField label={t("info.model")}>
        <Select
          selectedOption={selectedModel}
          options={modelOptions}
          filteringType="auto"
          onChange={({ detail }) => {
            const v = detail.selectedOption.value;
            if (!v) return;
            const slash = v.indexOf("/");
            onSetModel(v.slice(0, slash), v.slice(slash + 1));
          }}
        />
      </FormField>

      {/* 효율 (thinking level) */}
      {controls.supportsThinking ? (
        <FormField label={t("info.efficiency")}>
          <Select
            selectedOption={selectedThinking}
            options={thinkingOptions}
            onChange={({ detail }) => onSetThinking(detail.selectedOption.value as ThinkingLevel)}
          />
        </FormField>
      ) : null}

      {/* 컨텍스트 사용량 */}
      <FormField label={t("info.context")}>
        {usage && percent !== null ? (
          <SpaceBetween size="xxs">
            <ProgressBar value={Math.min(100, Math.round(percent))} />
            <Box fontSize="body-s" color="text-status-inactive">
              {t("info.contextUsage", {
                used: fmtNum(usage.tokens),
                total: fmtNum(usage.contextWindow),
                percent: Math.round(percent),
              })}
            </Box>
          </SpaceBetween>
        ) : (
          <Box color="text-status-inactive">{t("info.contextUnknown")}</Box>
        )}
      </FormField>

      {/* raw data */}
      <ExpandableSection headerText={t("info.rawData")} variant="footer">
        <KeyValuePairs
          columns={2}
          items={[
            { label: t("info.cost"), value: controls.stats?.cost != null ? `$${controls.stats.cost.toFixed(4)}` : "—" },
            { label: t("info.tokens"), value: fmtNum(controls.stats?.tokens?.total) },
            { label: t("info.messages"), value: fmtNum(controls.stats?.totalMessages) },
            { label: t("info.toolCalls"), value: fmtNum(controls.stats?.toolCalls) },
          ]}
        />
        <pre className="piweb-mono" style={{ whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.7, marginTop: 8 }}>
          {JSON.stringify(controls.stats ?? {}, null, 2)}
        </pre>
      </ExpandableSection>
    </SpaceBetween>
  );
}
