'use client';

import { useEffect, useReducer, useRef } from 'react';
import type { PaymentState } from '@/lib/payment-page-state';
import {
  INITIAL_PAY_ANNOUNCEMENT,
  PAY_STATUS_REGION_IDS,
  nextPayAnnouncement,
} from '@/lib/pay-status-a11y';

/** Persistent live regions for the pay flow; see lib/pay-status-a11y.js for the rules. */
export default function PayStatusRegion({ state }: { state: PaymentState }) {
  const [announcement, announce] = useReducer(nextPayAnnouncement, INITIAL_PAY_ANNOUNCEMENT);
  const announced = useRef<PaymentState | null>(null);

  // Once per pay-state object: StrictMode re-runs mount effects, which would
  // otherwise announce the on-load status as if it were a transition.
  useEffect(() => {
    if (announced.current === state) return;
    announced.current = state;
    announce(state);
  }, [state]);

  useEffect(() => {
    if (announcement.focusId) document.getElementById(announcement.focusId)?.focus();
  }, [announcement]);

  return (
    <>
      {/* aria-live is redundant with role="status" but recommended for compatibility; never added to role="alert". */}
      <div id={PAY_STATUS_REGION_IDS.polite} role="status" aria-live="polite" className="sr-only">
        {announcement.polite}
      </div>
      <div id={PAY_STATUS_REGION_IDS.assertive} role="alert" className="sr-only">
        {announcement.assertive}
      </div>
    </>
  );
}
