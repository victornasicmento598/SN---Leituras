import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F4F6F9] text-[#0F172A] flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl bg-white border-2 border-red-600 p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-2.5 text-red-700">
              <AlertTriangle className="w-7 h-7 shrink-0" />
              <h1 className="text-lg font-extrabold">
                Alerta de Execução • SN - Leituras
              </h1>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed">
              Ocorreu um erro inesperado na interface. Seus dados e rascunhos
              salvos no IndexedDB do aparelho permanecem intactos.
            </p>
            <pre className="p-3 rounded-xl bg-slate-100 border border-slate-300 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">
              {this.state.errorMessage}
            </pre>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, errorMessage: '' });
                window.location.reload();
              }}
              className="w-full min-h-[46px] rounded-xl bg-[#0A2239] text-white font-extrabold text-xs flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Recarregar Aplicativo</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
