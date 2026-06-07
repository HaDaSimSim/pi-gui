// Global error boundary — shows a recovery UI instead of a white screen when a component throws.

import { Component, type ErrorInfo, type ReactNode } from 'react';

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
    // Log to console for debugging (no server transmission — local tool).
    console.error('[pi-gui] render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground">
          <div className="text-lg font-semibold">Something went wrong</div>
          <pre className="max-h-60 max-w-2xl overflow-auto rounded-md border bg-muted p-3 text-left font-mono text-xs text-muted-foreground">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
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
