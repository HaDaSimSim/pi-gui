// 한 세션 탭: 메시지 + 컴포저 + 락 충돌 배너 + info 패널 토글.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Paperclip, Send, Info, X, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { useSession } from "./use-session";
import { MessageView } from "./message-view";
import { InfoPanel } from "./info-panel";
import { Footer } from "./footer";
import { UiRequestDialog } from "./ui-request-dialog";
import { useT } from "./i18n";

// File → data URL (백엔드가 data:<mime>;base64,<data> 를 파싱).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function SessionTab({ path, cwd, onTitle }: { path: string; cwd?: string; onTitle?: (name: string) => void }) {
  const { t } = useT();
  const { state, send, takeover, clearError, setModel, setThinking, rename, abort, respondUi } = useSession(path, cwd);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [commands, setCommands] = useState<{ name: string; description?: string; source: string }[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTextRef = useRef<string>("");

  // 라이브가 되면 슬래시 커맨드 목록을 불러온다 (extension 등록 커맨드).
  useEffect(() => {
    if (!state.live) {
      setCommands([]);
      return;
    }
    api.commands(path).then(setCommands).catch(() => undefined);
  }, [state.live, path]);

  // "/" 로 시작하면 커맨드 메뉴 (첫 토큰만, 공백 전). 필터링.
  const commandMenu = (() => {
    if (!commands.length) return null;
    const m = /^\/(\S*)$/.exec(input);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const matches = commands.filter((c) => c.name.toLowerCase().startsWith(q));
    return matches.length ? matches.slice(0, 8) : null;
  })();

  // 메뉴 내용이 바뀐 때 하이라이트 인덱스를 리셋.
  useEffect(() => {
    setCmdIndex(0);
  }, [input]);

  // 커맨드를 입력창에 채운다 (아직 전송은 안 함 — 인자 입력 여지).
  const applyCommand = (name: string) => setInput(`/${name} `);

  // 세션 이름이 정해지면 상위(App)로 올려 탭 label/브라우저 제목 갱신.
  useEffect(() => {
    if (state.name) onTitle?.(state.name);
  }, [state.name, onTitle]);

  // 새 메시지/스트리밍 시 맨 아래로 (스크롤 컨테이너 내부에서만)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  // 푸터 갱신 키: 스트리밍 끝날 때(false 로 전환) + 메시지 수 변화 시 다시 집계.
  const footerKey = (state.streaming ? 1 : 0) + state.messages.length;

  const onSubmit = async () => {
    const text = input.trim();
    if (!text && files.length === 0) return;
    lastTextRef.current = text;
    let images: string[] | undefined;
    if (files.length) {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      images = imgs.length ? await Promise.all(imgs.map(fileToDataUrl)) : undefined;
    }
    send(text, false, images);
    setInput("");
    setFiles([]);
  };

  const statusLine = useMemo(() => {
    if (state.streaming)
      return (
        <span className="flex items-center gap-1 text-amber-500">
          <Loader2 className="size-3 animate-spin" /> {t("session.streaming")}
        </span>
      );
    if (state.live) return <span className="text-emerald-500">{t("session.liveLockHeld")}</span>;
    return <span className="text-muted-foreground">{t("session.idle")}</span>;
  }, [state.streaming, state.live, t]);

  const lockedBy =
    state.conflict?.by?.label ||
    (state.conflict?.by ? `${state.conflict.by.owner} (pid ${state.conflict.by.pid})` : t("session.anotherClient"));

  return (
    <div className="flex h-full min-h-0">
      {/* ── 채팅 영역 ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 상단 미니 바 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
          <div>{statusLine}</div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("info.title")}
            onClick={() => setInfoOpen((v) => !v)}
          >
            <Info className="size-4" />
          </Button>
        </div>

        {/* 메시지 스크롤 영역 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-6 py-4">
            {state.loading ? (
              <div className="flex justify-center p-6">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : state.messages.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">{t("session.noMessages")}</div>
            ) : (
              <div className="flex w-full flex-col gap-4">
                {state.messages.map((m) => (
                  <MessageView key={m.key} msg={m} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 락 충돌 배너 */}
        {state.conflict ? (
          <div className="mx-3 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="mb-1 font-medium">
              {state.conflict.kind === "revoked" ? t("session.revokedHeader") : t("session.lockedHeader")}
            </div>
            <div className="mb-2 text-muted-foreground">{t("session.lockBody", { who: lockedBy })}</div>
            <Button size="sm" onClick={() => takeover(lastTextRef.current || undefined)}>
              {t("session.forceTakeover")}
            </Button>
          </div>
        ) : null}

        {state.error ? (
          <div className="mx-3 mt-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <span>{state.error}</span>
            <button onClick={clearError} aria-label="dismiss" className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        ) : null}

        {/* 컴포저 */}
        <div className="relative shrink-0 px-6 py-3">
          {/* 슬래시 커맨드 메뉴 ("/" 입력 시) */}
          {commandMenu ? (
            <div className="absolute bottom-full left-6 right-6 mb-1 overflow-hidden rounded-md border bg-popover shadow-md">
              {commandMenu.map((c, i) => (
                <button
                  key={c.name}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                    i === cmdIndex ? "bg-accent" : "hover:bg-accent",
                  )}
                  onMouseEnter={() => setCmdIndex(i)}
                  onClick={() => applyCommand(c.name)}
                >
                  <span className="font-mono font-medium">/{c.name}</span>
                  {c.source === "skill" ? (
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">skill</span>
                  ) : null}
                  {c.description ? (
                    <span className="truncate text-xs text-muted-foreground">{c.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {files.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <Badge key={i} variant="secondary" className="gap-1">
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button
                    aria-label={t("composer.removeAttachment")}
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label={t("composer.attach")}
              onClick={() => fileInputRef.current?.click()}
              disabled={state.loading}
            >
              <Paperclip className="size-4" />
            </Button>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                // 스크린샷/이미지 붙여넣기 대응.
                // 브라우저마다 이미지를 files 가 아니라 items(kind="file")에만 넣는
                // 경우가 있으므로 둘 다 확인한다.
                const imgs: File[] = [];
                for (const f of Array.from(e.clipboardData.files)) {
                  if (f.type.startsWith("image/")) imgs.push(f);
                }
                if (imgs.length === 0) {
                  for (const it of Array.from(e.clipboardData.items)) {
                    if (it.kind === "file" && it.type.startsWith("image/")) {
                      const f = it.getAsFile();
                      if (f) imgs.push(f);
                    }
                  }
                }
                if (imgs.length) {
                  e.preventDefault();
                  setFiles((prev) => [...prev, ...imgs]);
                }
              }}
              onKeyDown={(e) => {
                // 한글/IME 조합 중에는 Enter 를 가로채지 않는다.
                // composition 중 Enter 는 글자 확정용이므로 전송하면 마지막 글자가 잘린다.
                // (Chrome known issue — isComposing / keyCode 229 로 방어)
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                // 커맨드 메뉴가 떠 있으면 키보드로 탐색/선택.
                if (commandMenu) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCmdIndex((i) => (i + 1) % commandMenu.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdIndex((i) => (i - 1 + commandMenu.length) % commandMenu.length);
                    return;
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    applyCommand(commandMenu[cmdIndex]?.name ?? commandMenu[0].name);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput("");
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              placeholder={t("session.placeholder")}
              disabled={state.loading}
              rows={1}
              className="max-h-40 min-h-9 flex-1 resize-none"
            />
            {state.streaming ? (
              <Button
                size="icon"
                variant="destructive"
                className="shrink-0"
                aria-label={t("session.stop")}
                onClick={abort}
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="shrink-0"
                aria-label={t("session.send")}
                onClick={onSubmit}
                disabled={state.loading || (!input.trim() && files.length === 0)}
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {/* 푸터 (TUI 미러링) */}
        <Footer path={path} cwd={cwd} refreshKey={footerKey} />
      </div>

      {/* ── info 패널 (열리면 채팅이 좁아짐) ── */}
      {infoOpen ? (
        <div className="w-80 shrink-0 overflow-y-auto border-l">
          <InfoPanel
            state={state}
            onSetModel={(provider, id) => setModel(provider, id)}
            onSetThinking={(level) => setThinking(level)}
            onRename={(name) => rename(name)}
          />
        </div>
      ) : null}

      {/* extension UI 브릿지 (confirm/select/input/editor) */}
      {state.uiRequest ? <UiRequestDialog request={state.uiRequest} onRespond={respondUi} /> : null}
    </div>
  );
}
