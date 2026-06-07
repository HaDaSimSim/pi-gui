// Model/effort selector always shown above the composer.
// Model is a searchable combobox (shown as provider/id). Effort is always exposed.
// Can be changed even before the first message (held as a draft, applied on the first prompt).

import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { api, type ModelInfo, type ThinkingLevel } from './api';
import { useT } from './i18n';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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
    api
      .models()
      .then(setModels)
      .catch(() => undefined);
  }, []);

  const current = model ? `${model.provider}/${model.id}` : '';

  return (
    <div className="flex items-center gap-1.5">
      {/* model combobox — shown as provider/id, searchable */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="h-7 gap-1 px-2 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="max-w-[260px] truncate">{current || t('info.changeModel')}</span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder={t('info.changeModel')} className="text-xs" />
            <CommandList>
              <CommandEmpty>{t('settings.noModels')}</CommandEmpty>
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
                      <Check
                        className={cn(
                          'size-3.5 shrink-0',
                          current === value ? 'opacity-100' : 'opacity-0',
                        )}
                      />
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

      {/* effort — always exposed */}
      <Select
        value={thinking ?? undefined}
        onValueChange={(v) => onSetThinking(v as ThinkingLevel)}
      >
        <SelectTrigger
          size="sm"
          className="h-7 gap-1 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent"
        >
          <SelectValue placeholder={t('info.efficiency')} />
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
