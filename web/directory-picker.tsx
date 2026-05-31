// 디렉터리 선택 모달 — 새 세션을 시작할 폴더를 고른다.
// 같은 머신(로컬 전용)이라 서버 파일시스템을 직접 탐색한다.
// 두 가지 방법: (1) 폴더를 눌러 탐색 (2) 절대경로 직접 입력.

import { useCallback, useEffect, useState } from "react";
import { Folder, ChevronUp, CornerDownLeft, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "./api";
import { useT } from "./i18n";

export function DirectoryPicker({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [path, setPath] = useState<string>("");
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(""); // 절대경로 직접 입력칸

  // target 경로의 하위 디렉터리 목록을 불러온다 (없으면 홈에서 시작).
  const browse = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.fsList(target);
      setPath(r.path);
      setParent(r.parent);
      setDirs(r.dirs);
      setManual(r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse();
  }, [browse]);

  const join = (name: string) => (path.endsWith("/") ? `${path}${name}` : `${path}/${name}`);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[680px] w-[92vw] max-w-3xl flex-col gap-3 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("picker.title")}</DialogTitle>
        </DialogHeader>

        {/* 현재 경로 + 상위로 */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("picker.up")}
            disabled={!parent || loading}
            onClick={() => parent && browse(parent)}
          >
            <ChevronUp className="size-4" />
          </Button>
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs" dir="rtl" title={path}>
            {path || "…"}
          </code>
        </div>

        {/* 하위 폴더 목록 */}
        <div className="min-h-[12rem] flex-1 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : dirs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">{t("picker.empty")}</div>
          ) : (
            <div className="flex flex-col py-1">
              {dirs.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => browse(join(d))}
                >
                  <Folder className="size-4 shrink-0 text-sky-500" />
                  <span className="min-w-0 truncate">{d}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 절대경로 직접 입력 */}
        <div className="flex items-center gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={t("picker.manualPlaceholder")}
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && manual.trim()) browse(manual.trim());
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            aria-label={t("picker.go")}
            disabled={!manual.trim()}
            onClick={() => manual.trim() && browse(manual.trim())}
          >
            <CornerDownLeft className="size-4" />
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("info.cancel")}
          </Button>
          <Button disabled={!path || loading} onClick={() => onPick(path)}>
            {t("picker.useThis")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
