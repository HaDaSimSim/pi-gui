import { useEffect, useMemo, useRef, useState } from "react";
import Box from "@cloudscape-design/components/box";
import PromptInput from "@cloudscape-design/components/prompt-input";
import FileInput from "@cloudscape-design/components/file-input";
import FileTokenGroup from "@cloudscape-design/components/file-token-group";
import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useSession } from "./useSession";
import { MessageView } from "./MessageView";
import { InfoPanel } from "./InfoPanel";
import { useT } from "./i18n";

// 요소의 뷰포트 상단 offset 을 재서 "남은 높이"를 채운다.
// calc(100vh - 고정값) 추측 대신 실제 TopNav+Tabs 높이에 자동 적응.
function useFillHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number>(480);
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setHeight(Math.max(240, window.innerHeight - top));
    };
    measure();
    const raf = requestAnimationFrame(measure); // 탭 전환/레이아웃 정착 후 한 번 더
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(raf);
    };
  }, []);
  return { ref, height };
}

// File → data URL (백엔드가 data:<mime>;base64,<data> 를 파싱).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function SessionTab({ path }: { path: string }) {
  const { t } = useT();
  const { state, send, takeover, clearError, setModel, setThinking, rename } = useSession(path);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTextRef = useRef<string>("");
  const { ref: rootRef, height: rootHeight } = useFillHeight<HTMLDivElement>();

  // 새 메시지/스트리밍 시 맨 아래로 (스크롤 컨테이너 내부에서만)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const onSubmit = async () => {
    const text = input.trim();
    if (!text && files.length === 0) return;
    lastTextRef.current = text;
    let images: string[] | undefined;
    if (files.length) {
      // 이미지 파일만 인라인으로 첨부 (그 외는 무시 — pi prompt 는 ImageContent 만 받음)
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      images = imgs.length ? await Promise.all(imgs.map(fileToDataUrl)) : undefined;
    }
    send(text, false, images);
    setInput("");
    setFiles([]);
  };

  const statusLine = useMemo(() => {
    if (state.streaming) return <StatusIndicator type="loading">{t("session.streaming")}</StatusIndicator>;
    if (state.live) return <StatusIndicator type="success">{t("session.liveLockHeld")}</StatusIndicator>;
    return <Box variant="span" color="text-status-inactive">{t("session.idle")}</Box>;
  }, [state.streaming, state.live, t]);

  const lockedBy =
    state.conflict?.by?.label ||
    (state.conflict?.by ? `${state.conflict.by.owner} (pid ${state.conflict.by.pid})` : t("session.anotherClient"));

  return (
    // 루트: 측정된 높이로 고정. 내부는 flex 로 분배, 스크롤은 메시지 영역만.
    <div ref={rootRef} style={{ display: "flex", height: rootHeight, minHeight: 0, gap: 0 }}>
      {/* ── 채팅 영역 ── */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* 상단 미니 바: 상태 + info 토글 */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12 }}>{statusLine}</div>
          <Button
            variant="icon"
            iconName={infoOpen ? "angle-right" : "status-info"}
            ariaLabel={t("info.title")}
            onClick={() => setInfoOpen((v) => !v)}
          />
        </div>

        {/* 메시지 스크롤 영역 — minHeight:0 이 있어야 flex 안에서 실제로 스크롤된다 */}
        <div
          ref={scrollRef}
          className="piweb-chat-scroll"
          style={{ flex: 1, minHeight: 0, padding: "8px 12px" }}
        >
          {state.loading ? (
            <Box textAlign="center" padding="l">
              <Spinner size="large" />
            </Box>
          ) : state.messages.length === 0 ? (
            <Box color="text-status-inactive" textAlign="center" padding="xxl">
              {t("session.noMessages")}
            </Box>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", margin: 0 }}>
              {state.messages.map((m) => (
                <MessageView key={m.key} msg={m} />
              ))}
            </div>
          )}
        </div>

        {/* 락 충돌 배너 */}
        {state.conflict ? (
          <Box margin={{ horizontal: "s", top: "xs" }}>
            <Alert
              type="warning"
              header={state.conflict.kind === "revoked" ? t("session.revokedHeader") : t("session.lockedHeader")}
              action={
                <Button onClick={() => takeover(lastTextRef.current || undefined)} variant="primary">
                  {t("session.forceTakeover")}
                </Button>
              }
            >
              {t("session.lockBody", { who: lockedBy })}
            </Alert>
          </Box>
        ) : null}

        {state.error ? (
          <Box margin={{ horizontal: "s", top: "xs" }}>
            <Alert type="error" dismissible onDismiss={clearError}>
              {state.error}
            </Alert>
          </Box>
        ) : null}

        {/* 입력 (composer) */}
        <div style={{ flexShrink: 0, padding: "8px 12px" }}>
          <PromptInput
            value={input}
            onChange={({ detail }) => setInput(detail.value)}
            onAction={onSubmit}
            placeholder={t("session.placeholder")}
            actionButtonAriaLabel={t("session.send")}
            actionButtonIconName="send"
            disabled={state.loading}
            maxRows={8}
            secondaryActions={
              <Box padding={{ left: "xxs", top: "xs" }}>
                <FileInput
                  variant="icon"
                  multiple
                  value={files}
                  onChange={({ detail }) => setFiles(detail.value)}
                  ariaLabel={t("composer.attach")}
                >
                  {t("composer.attach")}
                </FileInput>
              </Box>
            }
            secondaryContent={
              files.length ? (
                <FileTokenGroup
                  alignment="horizontal"
                  items={files.map((f) => ({ file: f }))}
                  showFileSize
                  showFileThumbnail
                  onDismiss={({ detail }) =>
                    setFiles((prev) => prev.filter((_, i) => i !== detail.fileIndex))
                  }
                  i18nStrings={{
                    removeFileAriaLabel: () => t("composer.removeAttachment"),
                    limitShowFewer: "",
                    limitShowMore: "",
                  }}
                />
              ) : undefined
            }
          />
        </div>
      </div>

      {/* ── info 패널 (열리면 채팅이 좁아짐) ── */}
      {infoOpen ? (
        <div
          style={{
            width: 320,
            flexShrink: 0,
            minHeight: 0,
            borderLeft: "1px solid var(--color-border-divider-default, rgba(127,127,127,0.25))",
            overflowY: "auto",
            padding: 12,
          }}
        >
          <InfoPanel
            state={state}
            onSetModel={(provider, id) => setModel(provider, id)}
            onSetThinking={(level) => setThinking(level)}
            onRename={(name) => rename(name)}
          />
        </div>
      ) : null}
    </div>
  );
}
