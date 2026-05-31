// 컴포저 위에 항상 뜨는 모델/효율 셀렉터.
// 첫 메시지 전에도 바꿀 수 있다 (draft 로 들고 있다가 첫 prompt 에 적용).
// 라이브면 즉시 setModel/setThinking, 아니면 draft 만 갱신.

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type ModelInfo, type ThinkingLevel } from "./api";
import { useT } from "./i18n";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ModelControls({
  model,
  thinking,
  supportsThinking,
  onSetModel,
  onSetThinking,
}: {
  model: { provider: string; id: string } | null;
  thinking: ThinkingLevel | null;
  supportsThinking: boolean;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: ThinkingLevel) => void;
}) {
  const { t } = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined);
  }, []);

  const modelValue = model ? `${model.provider}/${model.id}` : undefined;

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={modelValue}
        onValueChange={(v) => {
          const slash = v.indexOf("/");
          onSetModel(v.slice(0, slash), v.slice(slash + 1));
        }}
      >
        <SelectTrigger size="sm" className="h-7 gap-1 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
          <SelectValue placeholder={t("info.changeModel")} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {models.map((m) => (
              <SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {supportsThinking ? (
        <>
          <span className="text-muted-foreground/40">·</span>
          <Select value={thinking ?? undefined} onValueChange={(v) => onSetThinking(v as ThinkingLevel)}>
            <SelectTrigger size="sm" className="h-7 gap-1 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
              <SelectValue placeholder={t("info.efficiency")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {THINKING_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
      ) : null}
    </div>
  );
}
