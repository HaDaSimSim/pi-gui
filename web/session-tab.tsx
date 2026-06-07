// A single session tab: messages + composer + lock-conflict banner + info panel toggle.

import {
  ChevronDown,
  Loader2,
  PanelRight,
  Paperclip,
  Pencil,
  Power,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { api } from './api';
import { Footer } from './footer';
import { useT } from './i18n';
import { InfoPanel } from './info-panel';
import { MessageView, SubagentOpenContext } from './message-view';
import { ModelControls } from './model-controls';
import { QuestionnaireDialog } from './questionnaire-dialog';
import { SubagentChatView } from './subagent-chat-view';
import { UiRequestDialog } from './ui-request-dialog';
import { useSession } from './use-session';

// File → data URL (the backend parses data:<mime>;base64,<data>).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function SessionTab({
  path,
  cwd,
  onTitle,
  onLive,
  onLiveChange,
}: {
  path: string;
  cwd?: string;
  onTitle?: (name: string) => void;
  onLive?: () => void;
  onLiveChange?: () => void;
}) {
  const { t } = useT();
  const {
    state,
    send,
    takeover,
    clearError,
    setModel,
    setThinking,
    rename,
    abort,
    shutdown,
    editQueue,
    respondUi,
    effectiveModel,
    effectiveThinking,
    turnStartRef,
  } = useSession(path, cwd);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  // Message windowing: large sessions only render the last N to avoid blocking the main thread.
  // (thousands of messages × markdown parsing = app freeze on sync render) Load more via "view earlier".
  const MSG_WINDOW = 60;
  const [visibleCount, setVisibleCount] = useState(MSG_WINDOW);
  // selected runId when expanding a subagent "like the main thread" (read-only).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [commands, setCommands] = useState<
    { name: string; description?: string; source: string }[]
  >([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTextRef = useRef<string>('');

  // Streaming elapsed time — re-render every second based on turnStartRef (turn start time).
  // turnStartRef is set once at agent_start, so it isn't reset mid-turn.
  // The retry countdown and compaction spinner also need per-second updates, so they tick together.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!state.streaming && !state.retry && !state.compaction) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.streaming, state.retry, state.compaction]);
  const streamElapsed =
    state.streaming && turnStartRef.current > 0 ? Date.now() - turnStartRef.current : 0;

  // The info panel is always open + resizable. It can be collapsed with the toggle button.
  const infoRef = usePanelRef();
  const toggleInfo = () => {
    const p = infoRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  };

  // Collect subagent-run entries in the session and pass them to the info panel (newest at the bottom).
  const subagentRuns = useMemo(
    () => state.messages.filter((m) => m.subagentRun).map((m) => m.subagentRun!),
    [state.messages],
  );
  // Re-find the selected run in the live list (reflects streaming updates while running).
  const selectedRun = useMemo(
    () => (selectedRunId ? (subagentRuns.find((r) => r.runId === selectedRunId) ?? null) : null),
    [selectedRunId, subagentRuns],
  );

  // Load the slash command list once live (extension-registered commands).
  useEffect(() => {
    if (!state.live) {
      setCommands([]);
      return;
    }
    api
      .commands(path)
      .then(setCommands)
      .catch(() => undefined);
  }, [state.live, path]);

  // If it starts with "/", show the command menu (first token only, before whitespace). Filter.
  // Besides extension/skill commands, always include the host builtin /reload.
  const commandMenu = (() => {
    const all = state.live
      ? [
          ...commands,
          { name: 'reload', description: t('reload.menuDesc'), source: 'builtin' as const },
        ]
      : commands;
    if (!all.length) return null;
    const m = /^\/(\S*)$/.exec(input);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const matches = all.filter((c) => c.name.toLowerCase().startsWith(q));
    return matches.length ? matches.slice(0, 8) : null;
  })();

  // Reset the highlight index when the menu contents change.
  useEffect(() => {
    setCmdIndex(0);
  }, []);

  // Fill the command into the input (don't send yet — leaves room for arguments).
  const applyCommand = (name: string) => setInput(`/${name} `);

  // When the session name is decided, propagate up to App to update tab label/browser title.
  // onTitle may be a new function each render, so pin it via ref and exclude it from deps
  // (otherwise onTitle→setState→new onTitle→effect re-run infinite loop).
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  // Same as TUI: if there's no name, use the first user prompt as the title.
  const firstUserMsg = useMemo(
    () =>
      state.messages
        .find((m) => m.role === 'user' && m.text.trim())
        ?.text.trim()
        .slice(0, 60),
    [state.messages],
  );
  useEffect(() => {
    const title = state.name || firstUserMsg;
    if (title) onTitleRef.current?.(title);
  }, [state.name, firstUserMsg]);

  // When the session transitions to live (first prompt accepted → file created), notify the parent.
  // App refreshes the session list for that cwd to turn the draft chip into a real session.
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  const wasLiveRef = useRef(false);
  useEffect(() => {
    if (state.live && !wasLiveRef.current) {
      wasLiveRef.current = true;
      onLiveRef.current?.();
      onLiveChangeRef.current?.();
    } else if (!state.live && wasLiveRef.current) {
      // live → read-only transition (lock released): update the sidebar dot.
      wasLiveRef.current = false;
      onLiveChangeRef.current?.();
    }
  }, [state.live]);

  // Scroll to bottom on new message/streaming — but only when the user is already near the bottom.
  // (prevents jumping to the end while scrolling up to view history)
  // But on first open (initial message load), always scroll to the bottom.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!didInitialScrollRef.current && state.messages.length > 0 && !state.loading) {
      didInitialScrollRef.current = true;
      // Scroll to bottom after layout (initial open).
      requestAnimationFrame(() => {
        const e = scrollRef.current;
        if (e) e.scrollTop = e.scrollHeight;
      });
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.loading]);

  // Auto-load history: when scrolled up near the top, increase visibleCount.
  // After increasing, prepended content grows the top, so compensate to avoid viewport jumps.
  const anchorRef = useRef<{ prevH: number; prevTop: number } | null>(null);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 120 && visibleCount < state.messages.length) {
      anchorRef.current = { prevH: el.scrollHeight, prevTop: el.scrollTop };
      setVisibleCount((n) => Math.min(state.messages.length, n + MSG_WINDOW));
    }
  };
  // When visibleCount changes and older messages are prepended, fix scroll position before paint.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    el.scrollTop = a.prevTop + (el.scrollHeight - a.prevH);
    anchorRef.current = null;
  }, []);

  // Footer refresh key: re-aggregate when streaming ends (transitions to false) + on message count change.
  const footerKey = (state.streaming ? 1 : 0) + state.messages.length;

  const onSubmit = async (modeOverride?: 'steer' | 'followUp') => {
    const text = input.trim();
    if (!text && files.length === 0) return;
    // builtin /reload — calls the extension reload API, not a prompt.
    if (text === '/reload') {
      setInput('');
      try {
        const r = await api.reload(path);
        if (r.ok) {
          toast.success(t('reload.done'));
          api
            .commands(path)
            .then(setCommands)
            .catch(() => undefined);
        } else if (r.reason === 'streaming') {
          toast.error(t('reload.streaming'));
        }
      } catch {
        toast.error(t('reload.failed'));
      }
      return;
    }
    lastTextRef.current = text;
    let images: string[] | undefined;
    if (files.length) {
      const imgs = files.filter((f) => f.type.startsWith('image/'));
      images = imgs.length ? await Promise.all(imgs.map(fileToDataUrl)) : undefined;
    }
    // While streaming, queue with the selected mode (steer/followUp); otherwise send normally.
    const deliverAs = state.streaming ? (modeOverride ?? 'steer') : undefined;
    send(text, false, images, deliverAs);
    setInput('');
    setFiles([]);
  };

  const statusLine = useMemo(() => {
    // While retrying (429/timeout/overload) — TUI-style warning-colored countdown.
    if (state.retry) {
      const secs = Math.max(0, Math.ceil((state.retry.until - Date.now()) / 1000));
      return (
        <span className="flex items-center gap-1.5 text-amber-500">
          <Loader2 className="size-3 animate-spin" />
          {t('retry.status', {
            a: String(state.retry.attempt),
            max: String(state.retry.maxAttempts),
            s: String(secs),
          })}
        </span>
      );
    }
    // While compacting — TUI-style accent-colored spinner.
    if (state.compaction) {
      const label =
        state.compaction.reason === 'manual'
          ? t('compaction.compacting')
          : state.compaction.reason === 'overflow'
            ? t('compaction.overflow')
            : t('compaction.auto');
      return (
        <span className="flex items-center gap-1.5 text-sky-500">
          <Loader2 className="size-3 animate-spin" /> {label}
        </span>
      );
    }
    if (state.streaming) {
      const sec = Math.floor(streamElapsed / 1000);
      const elapsed = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      return (
        <span className="flex items-center gap-1.5 text-amber-500">
          <Loader2 className="size-3 animate-spin" /> {t('session.streaming')}
          {sec > 0 ? <span className="tabular-nums text-muted-foreground">{elapsed}</span> : null}
        </span>
      );
    }
    if (state.live) return <span className="text-emerald-500">{t('session.liveLockHeld')}</span>;
    return <span className="text-muted-foreground">{t('session.idle')}</span>;
  }, [state.streaming, state.live, state.retry, state.compaction, streamElapsed, t]);

  const lockedBy =
    state.conflict?.by?.label ||
    (state.conflict?.by
      ? `${state.conflict.by.owner} (pid ${state.conflict.by.pid})`
      : t('session.anotherClient'));

  return (
    <ResizablePanelGroup className="h-full min-h-0">
      {/* ── Chat area ── */}
      <ResizablePanel className="min-w-0">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {/* Top mini bar */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-sm">
            <div>{statusLine}</div>
            <div className="flex items-center gap-1">
              {state.live ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  aria-label={t('session.shutdown')}
                  title={t('session.shutdown')}
                  onClick={shutdown}
                >
                  <Power className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('info.title')}
                onClick={toggleInfo}
              >
                <PanelRight className="size-4" />
              </Button>
            </div>
          </div>

          {/* Message scroll area */}
          <div ref={scrollRef} onScroll={onScroll} className="always-scrollbar min-h-0 flex-1">
            <div className="mx-auto max-w-7xl px-4 py-6">
              {state.loading ? (
                <div className="flex justify-center p-6">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : state.messages.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  {t('session.noMessages')}
                </div>
              ) : (
                <div className="flex w-full flex-col gap-7">
                  {state.messages.length > visibleCount ? (
                    <div className="py-2 text-center text-xs text-muted-foreground/60">
                      {t('session.loadingEarlier')}
                    </div>
                  ) : visibleCount > MSG_WINDOW ? (
                    <div className="py-2 text-center">
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          setVisibleCount(MSG_WINDOW);
                          const el = scrollRef.current;
                          if (el)
                            requestAnimationFrame(() => {
                              el.scrollTop = 0;
                            });
                        }}
                      >
                        {t('session.unloadEarlier', { count: String(visibleCount) })}
                      </button>
                    </div>
                  ) : null}
                  {(visibleCount >= state.messages.length
                    ? state.messages
                    : state.messages.slice(state.messages.length - visibleCount)
                  ).map((m) => (
                    <SubagentOpenContext.Provider
                      key={m.key}
                      value={(runId) => setSelectedRunId(runId)}
                    >
                      <MessageView msg={m} />
                    </SubagentOpenContext.Provider>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Lock-conflict banner */}
          {state.conflict ? (
            <div className="mx-4 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="mb-1 font-medium">
                {state.conflict.kind === 'revoked'
                  ? t('session.revokedHeader')
                  : t('session.lockedHeader')}
              </div>
              <div className="mb-2 text-muted-foreground">
                {t('session.lockBody', { who: lockedBy })}
              </div>
              <Button size="sm" onClick={() => takeover(lastTextRef.current || undefined)}>
                {t('session.forceTakeover')}
              </Button>
            </div>
          ) : null}

          {state.error ? (
            <div className="mx-4 mt-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <span>{state.error}</span>
              <button
                type="button"
                onClick={clearError}
                aria-label="dismiss"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          {/* Composer (or inline questionnaire — like TUI, the question appears in place of the input) */}
          {state.uiRequest?.kind === 'questionnaire' ? (
            <div className="shrink-0 px-4 py-4">
              <QuestionnaireDialog
                id={state.uiRequest.id}
                questions={state.uiRequest.questions ?? []}
                onRespond={respondUi}
                inline
              />
            </div>
          ) : (
            <div className="relative shrink-0 px-4 py-4">
              {/* Slash command menu (when typing "/") */}
              {commandMenu ? (
                <div className="absolute bottom-full left-4 right-4 mb-1 overflow-hidden rounded-md border bg-popover shadow-md">
                  {commandMenu.map((c, i) => (
                    <button
                      type="button"
                      key={c.name}
                      className={cn(
                        'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                        i === cmdIndex ? 'bg-accent' : 'hover:bg-accent',
                      )}
                      onMouseEnter={() => setCmdIndex(i)}
                      onClick={() => applyCommand(c.name)}
                    >
                      <span className="font-mono font-medium">/{c.name}</span>
                      {c.source === 'skill' ? (
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                          skill
                        </span>
                      ) : null}
                      {c.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {/* Queue during streaming: steering/followUp messages (editable/deletable) */}
              {state.queue.steering.length + state.queue.followUp.length > 0 ? (
                <div className="mb-2 flex flex-col gap-1">
                  {(['steering', 'followUp'] as const).flatMap((bucket) =>
                    state.queue[bucket].map((msg, i) => (
                      <div
                        key={`${bucket}-${msg}`}
                        className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                      >
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                          {bucket === 'steering' ? t('queue.steer') : t('queue.followUp')}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{msg}</span>
                        <button
                          type="button"
                          aria-label={t('queue.edit')}
                          title={t('queue.edit')}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => {
                            setInput(msg);
                            const next = {
                              ...state.queue,
                              [bucket]: state.queue[bucket].filter((_, j) => j !== i),
                            };
                            editQueue(next.steering, next.followUp);
                          }}
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('queue.delete')}
                          title={t('queue.delete')}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => {
                            const next = {
                              ...state.queue,
                              [bucket]: state.queue[bucket].filter((_, j) => j !== i),
                            };
                            editQueue(next.steering, next.followUp);
                          }}
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    )),
                  )}
                </div>
              ) : null}
              {files.length ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {files.map((f, i) => (
                    <Badge
                      key={`${f.name}-${f.size}-${f.lastModified}`}
                      variant="secondary"
                      className="gap-1"
                    >
                      <span className="max-w-[160px] truncate">{f.name}</span>
                      <button
                        type="button"
                        aria-label={t('composer.removeAttachment')}
                        onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
              {/* Model/effort selector (always shown, changeable even before the first message) */}
              <div className="mb-1.5">
                <ModelControls
                  model={effectiveModel}
                  thinking={effectiveThinking}
                  onSetModel={(provider, id) => setModel(provider, id)}
                  onSetThinking={(level) => setThinking(level)}
                />
              </div>
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files)
                      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                    e.target.value = '';
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  aria-label={t('composer.attach')}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={state.loading}
                >
                  <Paperclip className="size-4" />
                </Button>
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    // Handle screenshot/image paste.
                    // Some browsers put images only in items(kind="file") rather than files,
                    // so check both.
                    const imgs: File[] = [];
                    for (const f of Array.from(e.clipboardData.files)) {
                      if (f.type.startsWith('image/')) imgs.push(f);
                    }
                    if (imgs.length === 0) {
                      for (const it of Array.from(e.clipboardData.items)) {
                        if (it.kind === 'file' && it.type.startsWith('image/')) {
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
                    // Don't intercept Enter during Korean/IME composition.
                    // Enter during composition commits the character, so sending would cut off the last char.
                    // (Chrome known issue — guard via isComposing / keyCode 229)
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    // If the command menu is open, navigate/select with the keyboard.
                    if (commandMenu) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setCmdIndex((i) => (i + 1) % commandMenu.length);
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setCmdIndex((i) => (i - 1 + commandMenu.length) % commandMenu.length);
                        return;
                      }
                      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                        e.preventDefault();
                        applyCommand(commandMenu[cmdIndex]?.name ?? commandMenu[0].name);
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setInput('');
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSubmit();
                    }
                  }}
                  placeholder={t('session.placeholder')}
                  disabled={state.loading}
                  rows={1}
                  className="max-h-40 min-h-9 flex-1 resize-none"
                />
                {state.streaming ? (
                  <>
                    {/* While streaming: Send default=steer, ▾ menu lets you pick follow-up. */}
                    <div className="flex shrink-0">
                      <Button
                        size="icon"
                        className="shrink-0 rounded-r-none"
                        aria-label={t('queue.steer')}
                        title={t('queue.steerHint')}
                        onClick={() => onSubmit('steer')}
                        disabled={!input.trim() && files.length === 0}
                      >
                        <Send className="size-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="outline"
                            className="size-9 shrink-0 rounded-l-none border-l-0 px-1"
                            aria-label="More send options"
                            disabled={!input.trim() && files.length === 0}
                          >
                            <ChevronDown className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" side="top">
                          <DropdownMenuItem onClick={() => onSubmit('steer')}>
                            <span className="font-medium">{t('queue.steer')}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {t('queue.steerHint')}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onSubmit('followUp')}>
                            <span className="font-medium">{t('queue.followUp')}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {t('queue.followUpHint')}
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <Button
                      key="stop"
                      size="icon"
                      variant="destructive"
                      className="shrink-0"
                      aria-label={t('session.stop')}
                      onClick={abort}
                    >
                      <Square className="size-4" />
                    </Button>
                  </>
                ) : (
                  <Button
                    key="send"
                    size="icon"
                    className="shrink-0"
                    aria-label={t('session.send')}
                    onClick={() => onSubmit()}
                    disabled={state.loading || (!input.trim() && files.length === 0)}
                  >
                    <Send className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Footer (TUI mirroring) */}
          <Footer path={path} cwd={cwd} refreshKey={footerKey} />
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />
      <ResizablePanel
        panelRef={infoRef}
        collapsible
        collapsedSize={0}
        minSize="260px"
        defaultSize="340px"
        maxSize="560px"
        className="min-w-0 border-l"
      >
        <InfoPanel
          state={state}
          subagentRuns={subagentRuns}
          path={path}
          cwd={cwd}
          onSetModel={(provider, id) => setModel(provider, id)}
          onSetThinking={(level) => setThinking(level)}
          onRename={(name) => rename(name)}
          onOpenSubagent={(run) => setSelectedRunId(run.runId)}
        />
      </ResizablePanel>

      {/* questionnaire appears inline in place of the composer, so it's excluded here. Other ui requests use the dialog. */}
      {state.uiRequest && state.uiRequest.kind !== 'questionnaire' ? (
        <UiRequestDialog request={state.uiRequest} onRespond={respondUi} />
      ) : null}

      {/* Subagent run in a large modal (reuses the chat UI like the main thread, read-only) */}
      <Dialog open={!!selectedRun} onOpenChange={(o) => !o && setSelectedRunId(null)}>
        <DialogContent
          className="flex h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{selectedRun?.title ?? 'Subagent'}</DialogTitle>
          {selectedRun ? (
            <SubagentChatView run={selectedRun} onBack={() => setSelectedRunId(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </ResizablePanelGroup>
  );
}
