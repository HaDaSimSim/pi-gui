// 컴포저 위에 항상 뜨는 모델/효율 셀렉터.
// 모델은 검색 가능한 combobox (provider/id 로 표시). 효율은 항상 노출.
// 첫 메시지 전에도 바꿀 수 있다 (draft 로 들고 있다가 첫 prompt 에 적용).

import { useEffect, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, type ModelInfo, type ThinkingLevel } from "./api";
import { useT } from "./i18n";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ModelControls({
  model,
  thinking,
  onSetModel,
  onSetThinking,
}: {
  model: { provider: string; id: string } | null;
  thinking: ThinkingLevel | null;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: ThinkingLevel) => void;
}) {
  const { t } = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined);
  }, []);

  const current = model ? `${model.provider}/${model.id}` : "";

  return (
    <div className="flex items-center gap-1.5">
      {/* 모델 combobox — provider/id 로 표시, 검색 가능 */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="h-7 gap-1 px-2 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="max-w-[260px] truncate">{current || t("info.changeModel")}</span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder={t("info.changeModel")} className="text-xs" />
            <CommandList>
              <CommandEmpty>{t("settings.noModels")}</CommandEmpty>
              <CommandGroup>
                {models.map((m) => {
                  const value = `${m.provider}/${m.id}`;
                  return (
                    <CommandItem
                      key={value}
                      value={value}
                      onSelect={() => {
                        onSetModel(m.provider, m.id);
                        setOpen(false);
                      }}
                      className="gap-2 font-mono text-xs"
                    >
                      <Check className={cn("size-3.5 shrink-0", current === value ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{value}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <span className="text-muted-foreground/40">·</span>

      {/* 효율(effort) — 항상 노출 */}
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
    </div>
  );
}
