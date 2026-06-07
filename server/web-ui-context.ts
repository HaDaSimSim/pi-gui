// ExtensionUIContext implementation for pi-gui.
//
// Since there's no terminal, interactive UI (select/confirm/input/editor) sends a
// "ui_request" event to the browser over SSE; the browser receives it as a shadcn dialog,
// and the answer comes back via POST /api/session/ui-response to resolve the Promise.
//
// notify needs no response, so it only sends a "ui_notify" event (toast).
// The remaining terminal-only methods (setWidget/setFooter/custom/onTerminalInput, etc.)
// are safe no-ops. Our extensions that use custom (btw/question/subagents) are handled
// manually and separately on web.

type UiRequestKind = 'select' | 'confirm' | 'input' | 'editor' | 'questionnaire' | 'btw';

// questionnaire (structured questions) exchange type - the shape agreed on with the question extension.
export interface WebQuestionOption {
  value: string;
  label: string;
  description?: string;
}
export interface WebQuestion {
  id: string;
  label: string;
  prompt: string;
  options: WebQuestionOption[];
  multiSelect: boolean;
}
export interface WebAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
  values?: string[];
  labels?: string[];
}

export interface UiRequest {
  type: 'ui_request';
  id: string;
  kind: UiRequestKind;
  title: string;
  message?: string; // confirm
  placeholder?: string; // input/editor prefill
  options?: string[]; // select
  questions?: WebQuestion[]; // questionnaire
  answer?: string; // btw (markdown answer)
  timeout?: number;
}

export interface UiNotify {
  type: 'ui_notify';
  level: 'info' | 'warning' | 'error';
  message: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  kind: UiRequestKind;
};

let counter = 0;

export class WebUIContext {
  private broadcast: (event: unknown) => void;
  private pending = new Map<string, Pending>();

  constructor(broadcast: (event: unknown) => void) {
    this.broadcast = broadcast;
  }

  /** Receive the browser's response and resolve the pending Promise. false for an unknown id. */
  respond(id: string, value: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(value);
    return true;
  }

  /** Clear all pending requests as cancelled (undefined/false). Called on runtime dispose. */
  cancelAll() {
    for (const [, p] of this.pending) {
      p.resolve(p.kind === 'confirm' ? false : undefined);
    }
    this.pending.clear();
  }

  private request<T>(req: Omit<UiRequest, 'type' | 'id'>): Promise<T> {
    const id = `ui-${Date.now()}-${++counter}`;
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, kind: req.kind });
      this.broadcast({ type: 'ui_request', id, ...req } satisfies UiRequest);
      // timeout support: auto-release when set (confirm=false, otherwise undefined)
      if (req.timeout && req.timeout > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve((req.kind === 'confirm' ? false : undefined) as T);
          }
        }, req.timeout);
      }
    });
  }

  // -- Interactive: SSE bridge --
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number },
  ): Promise<string | undefined> {
    return this.request<string | undefined>({
      kind: 'select',
      title,
      options,
      timeout: opts?.timeout,
    });
  }
  confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean> {
    return this.request<boolean>({ kind: 'confirm', title, message, timeout: opts?.timeout });
  }
  input(
    title: string,
    placeholder?: string,
    opts?: { timeout?: number },
  ): Promise<string | undefined> {
    return this.request<string | undefined>({
      kind: 'input',
      title,
      placeholder,
      timeout: opts?.timeout,
    });
  }
  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.request<string | undefined>({ kind: 'editor', title, placeholder: prefill });
  }

  // questionnaire: sends structured questions as-is to the browser, received in a dedicated
  // dialog (tabs/options/multiSelect/free input). Called by the question extension when PI_WEB_HOST.
  // Returns { promise, cancel } so that if a remote (Telegram) answer arrives first, cancel()
  // can close the GUI dialog. promise is null on cancel.
  questionnaire(questions: WebQuestion[]): {
    promise: Promise<WebAnswer[] | null>;
    cancel: () => void;
  } {
    const id = `ui-${Date.now()}-${++counter}`;
    const promise = new Promise<WebAnswer[] | null>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, kind: 'questionnaire' });
      this.broadcast({
        type: 'ui_request',
        id,
        kind: 'questionnaire',
        title: '',
        questions,
      } satisfies UiRequest);
    });
    const _cancel = () => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        this.broadcast({ type: 'ui_cancel', id });
      }
    };
    // On cancel, resolve(null) and close the client.
    const wrapped = promise;
    return {
      promise: wrapped,
      cancel: () => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.resolve(null);
          this.broadcast({ type: 'ui_cancel', id });
        }
      },
    };
  }

  // btw: shows the side question's answer (markdown) in a read-only overlay (close only).
  // It is not saved to the conversation. Called by the btw extension when PI_WEB_HOST.
  showBtw(question: string, answer: string): Promise<void> {
    return this.request<void>({ kind: 'btw', title: question, answer });
  }

  // -- Notification: no response needed --
  notify(message: string, type: 'info' | 'warning' | 'error' = 'info') {
    this.broadcast({ type: 'ui_notify', level: type, message } satisfies UiNotify);
  }

  // -- Terminal-only: safe no-ops (matching the return types only) --
  onTerminalInput(): () => void {
    return () => {};
  }
  setStatus(): void {}
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setWidget(): void {}
  setFooter(): void {}
  setHeader(): void {}
  setTitle(): void {}
  // custom: a terminal component, so it can't be rendered on web. Return a no-op component-like
  // object so the call site doesn't break (our extensions are handled manually on web).
  custom(): { dispose?: () => void } {
    return { dispose() {} };
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return '';
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }
  getAllThemes(): string[] {
    return [];
  }
  getTheme(): undefined {
    return undefined;
  }
  setTheme(): void {}
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
