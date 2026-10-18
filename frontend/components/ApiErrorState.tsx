'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';

interface ApiErrorStateProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export default function ApiErrorState({ message, onRetry, compact = false }: ApiErrorStateProps) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = () => {
    if (!onRetry || retrying) return;

    setRetrying(true);
    try {
      Promise.resolve(onRetry())
        .catch(() => undefined)
        .finally(() => setRetrying(false));
    } catch {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`border border-red-200 bg-red-50 text-red-950 rounded-2xl ${compact ? 'p-4' : 'card py-10 text-center'}`}
    >
      <AlertTriangle className={`${compact ? 'w-5 h-5 inline mr-2' : 'w-12 h-12 mx-auto mb-4'} text-red-600`} />
      <p className="font-semibold">The Quittance API is unavailable</p>
      <p className="text-sm text-red-800 mt-1">{message}</p>
      {onRetry && (
        <button type="button" onClick={handleRetry} disabled={retrying} className="btn btn-outline mt-4 inline-flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying...' : 'Retry'}
        </button>
      )}
    </div>
  );
}
