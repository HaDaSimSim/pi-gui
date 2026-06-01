// pi-gui 용 ExtensionUIContext 구현.
//
// 터미널이 없으므로 인터랙티브 UI(select/confirm/input/editor)는 SSE 로 브라우저에
// "ui_request" 이벤트를 보내고, 브라우저가 shadcn 다이얼로그로 받아 응답하면
// POST /api/session/ui-response 로 돌아와 Promise 를 resolve 한다.
//
// notify 는 응답이 필요 없어 "ui_notify" 이벤트(toast)만 보낸다.
// 나머지 터미널 전용 메서드(setWidget/setFooter/custom/onTerminalInput 등)는
// 안전한 no-op. custom 을 쓰는 우리 extension(btw/question/subagents)은 web 에서
// 별도로 수동 대응한다.

type UiRequestKind = "select" | "confirm" | "input" | "editor" | "questionnaire" | "btw";

// questionnaire(구조화 질문) 교환 타입 — question 익스텐션과 합의된 모양.
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
  type: "ui_request";
  id: string;
  kind: UiRequestKind;
  title: string;
  message?: string; // confirm
  placeholder?: string; // input/editor prefill
  options?: string[]; // select
  questions?: WebQuestion[]; // questionnaire
  answer?: string; // btw (마크다운 답변)
  timeout?: number;
}

export interface UiNotify {
  type: "ui_notify";
  level: "info" | "warning" | "error";
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

  /** 브라우저 응답을 받아 보류 중인 Promise 를 resolve. 알 수 없는 id 면 false. */
  respond(id: string, value: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(value);
    return true;
  }

  /** 보류 중인 모든 요청을 취소(undefined/false)로 정리. 런타임 dispose 시 호출. */
  cancelAll() {
    for (const [, p] of this.pending) {
      p.resolve(p.kind === "confirm" ? false : undefined);
    }
    this.pending.clear();
  }

  private request<T>(req: Omit<UiRequest, "type" | "id">): Promise<T> {
    const id = `ui-${Date.now()}-${++counter}`;
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, kind: req.kind });
      this.broadcast({ type: "ui_request", id, ...req } satisfies UiRequest);
      // timeout 지원: 지정 시 자동 해제 (confirm=false, 그 외 undefined)
      if (req.timeout && req.timeout > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve((req.kind === "confirm" ? false : undefined) as T);
          }
        }, req.timeout);
      }
    });
  }

  // ── 인터랙티브: SSE 브릿지 ──
  select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> {
    return this.request<string | undefined>({ kind: "select", title, options, timeout: opts?.timeout });
  }
  confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean> {
    return this.request<boolean>({ kind: "confirm", title, message, timeout: opts?.timeout });
  }
  input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined> {
    return this.request<string | undefined>({ kind: "input", title, placeholder, timeout: opts?.timeout });
  }
  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.request<string | undefined>({ kind: "editor", title, placeholder: prefill });
  }

  // questionnaire: 구조화 질문을 그대로 브라우저로 보내 전용 다이얼로그(탭/옵션/
  // multiSelect/자유입력)로 받는다. question 익스텐션이 PI_WEB_HOST 일 때 호출.
  // 취소면 null, 아니면 Answer[] 를 돌려준다.
  questionnaire(questions: WebQuestion[]): Promise<WebAnswer[] | null> {
    return this.request<WebAnswer[] | null>({ kind: "questionnaire", title: "", questions });
  }

  // btw: 사이드 질문의 답변(마크다운)을 읽기전용 오버레이로 보여준다(닫기만).
  // 대화에 저장되지 않는다. btw 익스텐션이 PI_WEB_HOST 일 때 호출.
  showBtw(question: string, answer: string): Promise<void> {
    return this.request<void>({ kind: "btw", title: question, answer });
  }

  // ── 알림: 응답 불필요 ──
  notify(message: string, type: "info" | "warning" | "error" = "info") {
    this.broadcast({ type: "ui_notify", level: type, message } satisfies UiNotify);
  }

  // ── 터미널 전용: 안전한 no-op (반환 타입만 맞춤) ──
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
  // custom: 터미널 컴포넌트라 web 에서 그릴 수 없다. no-op 컴포넌트 like 객체를 돌려
  // 호출부가 깨지지 않게 한다 (우리 extension 은 web 에서 수동 대응).
  custom(): { dispose?: () => void } {
    return { dispose() {} };
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return "";
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
