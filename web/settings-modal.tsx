// Settings modal (shadcn Dialog). Large 16:9 layout + left-side category nav.
// Categories: General / Appearance / Font / Server (read-only). owner stays English.

import { Palette, Server, Settings2, Type } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { api, type LockRecord, type ModelInfo } from './api';
import { useT } from './i18n';
import {
  type DarkVariant,
  type Density,
  FONT_DEFAULTS,
  type ThemeModeTrigger,
  useUiSettings,
} from './use-ui-settings';

interface LiveRow {
  key: string;
  cwd: string;
  streaming: boolean;
  lockMine: boolean;
}

type Section = 'general' | 'appearance' | 'fonts' | 'server';

// owner label is not i18n'd, stays English (by request).
function ownerLabel(owner: string): string {
  if (owner === 'pi-web') return 'pi-web';
  if (owner === 'pi') return 'pi (TUI/CLI)';
  return owner || 'unknown';
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium">{label}</div>
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      <div className="pt-1">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

export function SettingsModal({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const { settings, update } = useUiSettings();
  const { t } = useT();
  const [section, setSection] = useState<Section>('general');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [locks, setLocks] = useState<LockRecord[] | null>(null);
  const [live, setLive] = useState<LiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadServer = useCallback(() => {
    setError(null);
    api
      .models()
      .then(setModels)
      .catch((e) => setError(String(e)));
    api
      .locks()
      .then(setLocks)
      .catch((e) => setError(String(e)));
    api
      .live()
      .then(setLive)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (visible && section === 'server') loadServer();
  }, [visible, section, loadServer]);

  const nav: { id: Section; label: string; icon: typeof Settings2 }[] = [
    { id: 'general', label: t('settings.navGeneral'), icon: Settings2 },
    { id: 'appearance', label: t('settings.appearance'), icon: Palette },
    { id: 'fonts', label: t('settings.fonts'), icon: Type },
    { id: 'server', label: t('settings.navServer'), icon: Server },
  ];

  return (
    <Dialog open={visible} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent
        showCloseButton
        className="grid h-[80vh] max-h-[680px] w-[92vw] max-w-5xl grid-cols-[200px_1fr] gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">{t('settings.heading')}</DialogTitle>

        {/* left-side category nav */}
        <nav className="flex flex-col gap-1 border-r bg-muted/30 p-3">
          <div className="px-2 pb-2 pt-1 text-sm font-semibold">{t('settings.heading')}</div>
          {nav.map((n) => {
            const Icon = n.icon;
            const active = section === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* right-side content (vertical scroll only, no horizontal) */}
        <div className="min-w-0 overflow-y-auto">
          <div className="flex flex-col gap-6 p-6">
            {section === 'general' ? (
              <>
                <SectionTitle>{t('settings.navGeneral')}</SectionTitle>
                <Field label={t('settings.language')} description={t('settings.languageDesc')}>
                  <RadioGroup
                    value={settings.lang}
                    onValueChange={(v) => update({ lang: v as 'en' | 'ko' })}
                    className="flex gap-4"
                  >
                    <label htmlFor="lang-en" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="lang-en" value="en" /> English
                    </label>
                    <label htmlFor="lang-ko" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="lang-ko" value="ko" /> 한국어
                    </label>
                  </RadioGroup>
                </Field>
              </>
            ) : null}

            {section === 'appearance' ? (
              <>
                <SectionTitle>{t('settings.appearance')}</SectionTitle>
                <Field label={t('settings.theme')} description={t('settings.themeDesc')}>
                  <RadioGroup
                    value={settings.themeMode}
                    onValueChange={(v) => update({ themeMode: v as ThemeModeTrigger })}
                    className="flex gap-4"
                  >
                    <label htmlFor="theme-auto" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="theme-auto" value="auto" /> {t('settings.themeAuto')}
                    </label>
                    <label htmlFor="theme-light" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="theme-light" value="light" /> {t('settings.light')}
                    </label>
                    <label htmlFor="theme-dark" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="theme-dark" value="dark" /> {t('settings.dark')}
                    </label>
                  </RadioGroup>
                </Field>
                <Field
                  label={t('settings.darkVariant')}
                  description={t('settings.darkVariantDesc')}
                >
                  <RadioGroup
                    value={settings.darkVariant}
                    onValueChange={(v) => update({ darkVariant: v as DarkVariant })}
                    className="flex gap-4"
                  >
                    <label htmlFor="darkvar-dark" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="darkvar-dark" value="dark" /> {t('settings.dark')}
                    </label>
                    <label htmlFor="darkvar-true-dark" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="darkvar-true-dark" value="true-dark" />{' '}
                      {t('settings.trueDark')}
                    </label>
                  </RadioGroup>
                </Field>
                <Field label={t('settings.density')} description={t('settings.densityDesc')}>
                  <RadioGroup
                    value={settings.density}
                    onValueChange={(v) => update({ density: v as Density })}
                    className="flex gap-4"
                  >
                    <label
                      htmlFor="density-comfortable"
                      className="flex items-center gap-2 text-sm"
                    >
                      <RadioGroupItem id="density-comfortable" value="comfortable" />{' '}
                      {t('settings.comfortable')}
                    </label>
                    <label htmlFor="density-compact" className="flex items-center gap-2 text-sm">
                      <RadioGroupItem id="density-compact" value="compact" />{' '}
                      {t('settings.compact')}
                    </label>
                  </RadioGroup>
                </Field>
                <Field label={t('settings.motion')} description={t('settings.motionDesc')}>
                  <label htmlFor="motion-reduce" className="flex items-center gap-2 text-sm">
                    <Switch
                      id="motion-reduce"
                      checked={settings.motionDisabled}
                      onCheckedChange={(c) => update({ motionDisabled: c })}
                    />
                    {t('settings.reduceMotion')}
                  </label>
                </Field>
              </>
            ) : null}

            {section === 'fonts' ? (
              <>
                <SectionTitle>{t('settings.fonts')}</SectionTitle>
                <Field label={t('settings.fontSans')} description={t('settings.fontSansDesc')}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.fontSans}
                      onChange={(e) => update({ fontSans: e.target.value })}
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => update({ fontSans: FONT_DEFAULTS.sans })}
                    >
                      {t('settings.resetDefault')}
                    </Button>
                  </div>
                </Field>
                <Field label={t('settings.fontMono')} description={t('settings.fontMonoDesc')}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.fontMono}
                      onChange={(e) => update({ fontMono: e.target.value })}
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => update({ fontMono: FONT_DEFAULTS.mono })}
                    >
                      {t('settings.resetDefault')}
                    </Button>
                  </div>
                </Field>
                <div className="rounded-md border p-3">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {t('settings.fontPreview')}
                  </div>
                  <div style={{ fontFamily: settings.fontSans }} className="text-sm">
                    The quick brown fox jumps over the lazy dog · 다람쥐 헌 쳇바퀴에 타고파
                  </div>
                  <div style={{ fontFamily: settings.fontMono }} className="mt-1 text-sm">
                    const x = 42; {'//'} 0123456789 {'=>'} {'{}'}
                  </div>
                </div>
              </>
            ) : null}

            {section === 'server' ? (
              <>
                <div className="flex items-center justify-between">
                  <SectionTitle>{t('settings.navServer')}</SectionTitle>
                  <Button variant="outline" size="sm" onClick={loadServer}>
                    {t('settings.refresh')}
                  </Button>
                </div>

                {/* model */}
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-semibold">
                    {t('settings.models')}{' '}
                    {models ? (
                      <span className="text-muted-foreground">({models.length})</span>
                    ) : null}
                  </div>
                  <div className="max-h-56 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('settings.colProvider')}</TableHead>
                          <TableHead>{t('settings.colName')}</TableHead>
                          <TableHead>{t('settings.colId')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {models?.length ? (
                          models.map((m) => (
                            <TableRow key={`${m.provider}/${m.id}`}>
                              <TableCell>{m.provider}</TableCell>
                              <TableCell>{m.name}</TableCell>
                              <TableCell className="font-mono text-xs">{m.id}</TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              {models === null && !error
                                ? t('settings.loadingModels')
                                : t('settings.noModels')}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* active locks */}
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-semibold">
                    {t('settings.locks')}{' '}
                    {locks ? <span className="text-muted-foreground">({locks.length})</span> : null}
                  </div>
                  <div className="max-h-56 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('settings.colOwner')}</TableHead>
                          <TableHead>{t('settings.colLabel')}</TableHead>
                          <TableHead>{t('settings.colPid')}</TableHead>
                          <TableHead>{t('settings.colSession')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {locks?.length ? (
                          locks.map((l) => (
                            <TableRow key={`${l.owner}-${l.pid}-${l.sessionPath}`}>
                              <TableCell>
                                <Badge variant={l.owner === 'pi-web' ? 'default' : 'secondary'}>
                                  {ownerLabel(l.owner)}
                                </Badge>
                              </TableCell>
                              <TableCell>{l.label || '—'}</TableCell>
                              <TableCell>{l.pid}</TableCell>
                              <TableCell
                                className="max-w-[220px] truncate font-mono text-xs"
                                title={l.sessionPath}
                              >
                                {l.sessionPath}
                              </TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground">
                              {locks === null && !error
                                ? t('settings.loadingLocks')
                                : t('settings.noLocks')}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* live runtimes */}
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-semibold">
                    {t('settings.live')}{' '}
                    {live ? <span className="text-muted-foreground">({live.length})</span> : null}
                  </div>
                  <div className="max-h-56 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('settings.colDirectory')}</TableHead>
                          <TableHead>{t('settings.colStatus')}</TableHead>
                          <TableHead>{t('settings.colLock')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {live?.length ? (
                          live.map((r) => (
                            <TableRow key={r.key}>
                              <TableCell className="max-w-[240px] truncate" title={r.cwd}>
                                {r.cwd}
                              </TableCell>
                              <TableCell>
                                {r.streaming ? (
                                  <span className="text-amber-500">
                                    {t('settings.statusStreaming')}
                                  </span>
                                ) : (
                                  <span className="text-emerald-500">
                                    {t('settings.statusIdle')}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {r.lockMine ? (
                                  <span className="text-emerald-500">{t('settings.lockHeld')}</span>
                                ) : (
                                  <span className="text-amber-500">{t('settings.lockLost')}</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              {live === null && !error
                                ? t('settings.loadingLive')
                                : t('settings.noLive')}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {error ? (
                  <div className="text-sm text-destructive">
                    {t('settings.loadError', { error })}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
