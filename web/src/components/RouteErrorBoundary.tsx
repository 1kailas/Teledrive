import { useRouteError, useNavigate } from 'react-router';
import { RotateCw, Home, AlertTriangle } from 'lucide-react';
import { useState } from 'react';

export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const [showDetails, setShowDetails] = useState(false);

  const errorMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);

  const errorStack = error instanceof Error ? error.stack : '';

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-surface p-6">
      <div className="surface border border-app rounded-2xl shadow-xl max-w-md w-full p-6 text-center space-y-4">
        <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500">
          <AlertTriangle size={28} />
        </div>

        <div>
          <h2 className="text-lg font-semibold text-text">Something went wrong</h2>
          <p className="text-3 text-xs mt-1">
            TeleDrive ran into an unexpected issue while rendering this view.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            className="btn btn-primary !px-4 !py-2 text-xs flex items-center gap-1.5"
            onClick={() => navigate('/drive', { replace: true })}
          >
            <Home size={14} /> Back to My Drive
          </button>
          <button
            className="btn !px-4 !py-2 text-xs flex items-center gap-1.5"
            onClick={() => window.location.reload()}
          >
            <RotateCw size={14} /> Reload
          </button>
        </div>

        <div className="pt-2 border-t border-app">
          <button
            className="text-[11px] text-3 hover:text-text underline"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? 'Hide technical details' : 'Show technical details'}
          </button>

          {showDetails && (
            <div className="mt-2 text-left bg-surface-2 p-2.5 rounded-lg border border-app text-[11px] font-mono text-3 max-h-40 overflow-auto break-all">
              <div className="text-red-400 font-semibold mb-1">{errorMessage}</div>
              {errorStack && <pre className="whitespace-pre-wrap text-[10px] opacity-75">{errorStack}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
