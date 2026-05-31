// 설정 모달 (shadcn Dialog). 외관(언어/테마/밀도/모션/폰트) +
// 서버 상태 읽기 전용(모델/락/라이브). owner 는 영어 고정.

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUiSettings, FONT_DEFAULTS, type ThemeMode, type Density } from "./use-ui-settings";
import { useT } from "./i18n";
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

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium">{label}</div>
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      <div className="pt-0.5">{children}</div>
    </div>
  );
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

  useEffect(() => {
    if (visible) loadServer();
  }, [visible, loadServer]);

  return (
    <Dialog open={visible} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings.heading")}</DialogTitle>
          <DialogDescription>{t("settings.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* 외관 */}
          <div className="flex flex-col gap-4">
            <div className="text-sm font-semibold">{t("settings.appearance")}</div>

            <Field label={t("settings.language")} description={t("settings.languageDesc")}>
              <RadioGroup
                value={settings.lang}
                onValueChange={(v) => update({ lang: v as "en" | "ko" })}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="en" /> English
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="ko" /> 한국어
                </label>
              </RadioGroup>
            </Field>

            <Field label={t("settings.theme")} description={t("settings.themeDesc")}>
              <RadioGroup
                value={settings.theme}
                onValueChange={(v) => update({ theme: v as ThemeMode })}
                className="flex flex-col gap-2"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="light" /> {t("settings.light")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="dark" /> {t("settings.dark")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="true-dark" /> {t("settings.trueDark")}
                  <span className="text-xs text-muted-foreground">— {t("settings.trueDarkDesc")}</span>
                </label>
              </RadioGroup>
            </Field>

            <Field label={t("settings.density")} description={t("settings.densityDesc")}>
              <RadioGroup
                value={settings.density}
                onValueChange={(v) => update({ density: v as Density })}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="comfortable" /> {t("settings.comfortable")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="compact" /> {t("settings.compact")}
                </label>
              </RadioGroup>
            </Field>

            <Field label={t("settings.motion")} description={t("settings.motionDesc")}>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={settings.motionDisabled} onCheckedChange={(c) => update({ motionDisabled: c })} />
                {t("settings.reduceMotion")}
              </label>
            </Field>
          </div>

          <Separator />

          {/* 폰트 */}
          <div className="flex flex-col gap-4">
            <div className="text-sm font-semibold">{t("settings.fonts")}</div>
            <Field label={t("settings.fontSans")} description={t("settings.fontSansDesc")}>
              <div className="flex items-center gap-2">
                <Input value={settings.fontSans} onChange={(e) => update({ fontSans: e.target.value })} className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => update({ fontSans: FONT_DEFAULTS.sans })}>
                  {t("settings.resetDefault")}
                </Button>
              </div>
            </Field>
            <Field label={t("settings.fontMono")} description={t("settings.fontMonoDesc")}>
              <div className="flex items-center gap-2">
                <Input value={settings.fontMono} onChange={(e) => update({ fontMono: e.target.value })} className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => update({ fontMono: FONT_DEFAULTS.mono })}>
                  {t("settings.resetDefault")}
                </Button>
              </div>
            </Field>
          </div>

          <Separator />

          {/* 모델 (읽기 전용) */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">
                {t("settings.models")} {models ? <span className="text-muted-foreground">({models.length})</span> : null}
              </div>
              <Button variant="ghost" size="sm" onClick={loadServer}>
                {t("settings.refresh")}
              </Button>
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("settings.colProvider")}</TableHead>
                    <TableHead>{t("settings.colName")}</TableHead>
                    <TableHead>{t("settings.colId")}</TableHead>
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
                        {models === null && !error ? t("settings.loadingModels") : t("settings.noModels")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* 활성 락 */}
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold">
              {t("settings.locks")} {locks ? <span className="text-muted-foreground">({locks.length})</span> : null}
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("settings.colOwner")}</TableHead>
                    <TableHead>{t("settings.colLabel")}</TableHead>
                    <TableHead>{t("settings.colPid")}</TableHead>
                    <TableHead>{t("settings.colSession")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locks?.length ? (
                    locks.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Badge variant={l.owner === "pi-web" ? "default" : "secondary"}>{ownerLabel(l.owner)}</Badge>
                        </TableCell>
                        <TableCell>{l.label || "—"}</TableCell>
                        <TableCell>{l.pid}</TableCell>
                        <TableCell className="max-w-[260px] truncate font-mono text-xs" title={l.sessionPath}>
                          {l.sessionPath}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        {locks === null && !error ? t("settings.loadingLocks") : t("settings.noLocks")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* 라이브 런타임 */}
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold">
              {t("settings.live")} {live ? <span className="text-muted-foreground">({live.length})</span> : null}
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("settings.colDirectory")}</TableHead>
                    <TableHead>{t("settings.colStatus")}</TableHead>
                    <TableHead>{t("settings.colLock")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {live?.length ? (
                    live.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="max-w-[280px] truncate" title={r.cwd}>
                          {r.cwd}
                        </TableCell>
                        <TableCell>
                          {r.streaming ? (
                            <span className="text-amber-500">{t("settings.statusStreaming")}</span>
                          ) : (
                            <span className="text-emerald-500">{t("settings.statusIdle")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {r.lockMine ? (
                            <span className="text-emerald-500">{t("settings.lockHeld")}</span>
                          ) : (
                            <span className="text-amber-500">{t("settings.lockLost")}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground">
                        {live === null && !error ? t("settings.loadingLive") : t("settings.noLive")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {error ? <div className="text-sm text-destructive">{t("settings.loadError", { error })}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
