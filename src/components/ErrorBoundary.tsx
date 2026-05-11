import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 미처리 React 에러로 화이트 스크린이 되는 사고 방지. 사용자가 진행 중이던 회의의
// 녹음 데이터를 잃지 않도록 "재시작 안내 + 녹음 폴더 위치"를 항상 같이 보여준다.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 처리되지 않은 에러:", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error.message || String(this.state.error);
    const stack = this.state.error.stack ?? "";

    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-200 p-8">
        <div className="max-w-xl w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl">
          <h1 className="text-lg font-semibold text-red-400 mb-2">앱에 오류가 발생했습니다</h1>
          <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
            화면이 멈췄거나 비정상적으로 동작하고 있습니다. 진행 중이던 녹음 파일은
            <code className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-xs">
              ~/Documents/Notetaker/recordings/
            </code>
            에 안전하게 저장돼 있습니다.
          </p>

          <details className="mb-4 text-xs">
            <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
              자세한 오류 정보 (개발자에게 공유)
            </summary>
            <pre className="mt-2 p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 overflow-auto max-h-60 whitespace-pre-wrap break-words">
              {message}
              {stack ? `\n\n${stack}` : ""}
            </pre>
          </details>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-2 rounded-xl bg-white text-black text-sm font-medium hover:bg-zinc-100 transition-colors cursor-pointer"
            >
              앱 다시 시작
            </button>
          </div>
        </div>
      </div>
    );
  }
}
