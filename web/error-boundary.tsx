// 전역 에러 바운더리 — 컴포넌트가 throw 해도 흰 화면 대신 복구 UI 를 보여준다.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 콘솔에 남겨 디버깅 (서버 전송은 하지 않음 — 로컬 도구).
    console.error("[pi-web] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground">
          <div className="text-lg font-semibold">Something went wrong</div>
          <pre className="max-h-60 max-w-2xl overflow-auto rounded-md border bg-muted p-3 text-left font-mono text-xs text-muted-foreground">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <div className="flex gap-2">
            <button
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
