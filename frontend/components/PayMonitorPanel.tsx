'use client';

import { Loader2, AlertTriangle } from 'lucide-react';
import { paymentMonitorLabels } from '@/lib/payment-monitor';

interface PayMonitorPanelProps {
  active: boolean;
  intervalMs: number;
  error?: Error | null;
  onRetry?: () => void;
}

export default function PayMonitorPanel({ active, intervalMs, error, onRetry }: PayMonitorPanelProps) {
  const copy = active ? paymentMonitorLabels.listening : paymentMonitorLabels.paused;

  if (error) {
    return (
      <aside
        role="alert"
        aria-live="polite"
        className="card flex items-center gap-3 bg-amber-50 border border-amber-200"
        data-monitor-state="error"
      >
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" aria-hidden="true" />
        <div className="flex-1">
          <p className="font-semibold text-amber-900">Monitoring Error</p>
          <p className="text-sm text-amber-800">{error.message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              type="button"
              className="mt-2 text-sm font-medium text-amber-700 hover:text-amber-900 underline"
              aria-label="Retry payment monitoring"
            >
              Retry
            </button>
          )}
        </div>
      </aside>
    );
  }

  const intervalLabel = intervalMs > 0 ? ` Checking every ${Math.round(intervalMs / 1000)} seconds.` : '';

  return (
    <aside aria-live="polite" className="card flex items-center gap-3" data-monitor-state={active ? 'listening' : 'paused'}>
      {active && <Loader2 className="w-4 h-4 animate-spin text-cyan-600" aria-hidden="true" />}
      <div>
        <p className="font-semibold text-gray-900">{copy.title}</p>
        <p className="text-sm text-gray-600">{copy.description}{active && intervalLabel}</p>
      </div>
    </aside>
  );
}
