'use client';

import { useRef, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Boundary } from './Boundary';
import { PAY_FOCUS_IDS } from '@/lib/pay-status-a11y';

interface PayVerifyPanelProps {
  txHash: string;
  verifying: boolean;
  /** Last verification failure, shown inline and linked to the input. */
  error: string | null;
  onChange: (value: string) => void;
  /** Resolves true when the transaction verified. */
  onVerify: () => Promise<boolean>;
}

function PayVerifyPanel({ txHash, verifying, error, onChange, onVerify }: PayVerifyPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // A form so Enter in the hash field submits, as it does in every other form.
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (verifying) return;
    if (!(await onVerify())) inputRef.current?.focus();
  };

  return (
    <section aria-labelledby="verify-title" className="card">
      <h3 id="verify-title" className="text-lg font-semibold text-center mb-4">Already paid? Verify your transaction</h3>
      <form onSubmit={handleSubmit} noValidate>
        <p id="tx-hash-hint" className="text-sm text-gray-600 text-center mb-2">Enter the 64-character Stellar transaction hash.</p>
        <div className="flex items-center gap-2 mb-2">
          <input
            ref={inputRef}
            id={PAY_FOCUS_IDS.verifyInput}
            aria-label="Transaction hash"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `tx-hash-hint ${PAY_FOCUS_IDS.verifyError}` : 'tx-hash-hint'}
            value={txHash}
            onChange={(event) => onChange(event.target.value)}
            maxLength={64}
            className="input flex-1"
          />
          {/* aria-disabled, not disabled: some browsers (Chromium) move focus to <body> when the focused button is disabled. */}
          <button type="submit" aria-disabled={verifying} aria-busy={verifying} className="btn btn-primary flex items-center gap-2">
            {verifying && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {verifying ? 'Verifying...' : 'Verify'}
          </button>
        </div>
        {error && (
          <p id={PAY_FOCUS_IDS.verifyError} className="field-error text-center mb-2">
            {error}
          </p>
        )}
      </form>
      <p className="text-xs text-gray-500 text-center">Manual verification remains available for QR and external-wallet payments.</p>
    </section>
  );
}

export default function BoundaryWrappedPayVerifyPanel(props: PayVerifyPanelProps) {
  return (
    <Boundary name="PayVerifyPanel" fallbackMessage="Failed to load verification panel">
      <PayVerifyPanel {...props} />
    </Boundary>
  );
}
