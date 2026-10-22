/**
 * The invoice lifecycle: one state machine, shared by the backend API, both
 * storage backends and the Next.js client.
 *
 * Before this module "what may happen to an invoice in state X" was inferred
 * separately in each place that needed it: `if (status !== 'PENDING')` in the
 * memory store, `WHERE status = 'PENDING'` in SQL, `checkInvoiceIsPayable` in
 * the verifier and `isActionableInvoice` in the UI. Those agree today because
 * someone kept them agreeing. This file is the single place the rules are
 * written down; the stores, handlers and UI ask it instead of re-deriving them.
 *
 * The table below is deliberately data, not code, so it can be listed by the
 * API (`GET /api/invoices/lifecycle`), rendered in docs and exhaustively
 * asserted by tests.
 *
 * What the model does NOT decide is time. Whether a PENDING invoice is still
 * inside its expiry window is a fact about the clock, and stays a guard in the
 * storage layer (`expires_at > NOW()`), next to the write it protects.
 */

export const INVOICE_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Why an invoice moves. Events, not target states, are what callers raise: two
 * different events may lead to the same state (`SETTLE` and `SETTLE_LATE` both
 * end in PAID) and the audit log needs to tell them apart.
 */
export type InvoiceEvent = 'SETTLE' | 'SETTLE_AFTER_CANCEL' | 'CANCEL' | 'EXPIRE';

export interface InvoiceTransition {
  readonly from: InvoiceStatus;
  readonly event: InvoiceEvent;
  readonly to: InvoiceStatus;
  readonly description: string;
}

/**
 * Every legal transition. Anything not listed here is illegal.
 *
 * PAID and EXPIRED are terminal. CANCELLED is *nearly* terminal: a seller may
 * cancel an invoice while the client's payment is already on its way, and a
 * payment the ledger shows as settled is money that has moved regardless of
 * what the invoice says, so it must still be recordable (see
 * docs/LATE_PAYMENT_POLICY.md).
 */
export const INVOICE_TRANSITIONS: readonly InvoiceTransition[] = [
  {
    from: 'PENDING',
    event: 'SETTLE',
    to: 'PAID',
    description: 'A verified payment settled the invoice inside its expiry window.',
  },
  {
    from: 'PENDING',
    event: 'CANCEL',
    to: 'CANCELLED',
    description: 'The seller cancelled an invoice that had not been paid.',
  },
  {
    from: 'PENDING',
    event: 'EXPIRE',
    to: 'EXPIRED',
    description: 'The expiry time passed while the invoice was still unpaid.',
  },
  {
    from: 'CANCELLED',
    event: 'SETTLE_AFTER_CANCEL',
    to: 'PAID',
    description: 'A verified payment was found for an invoice the seller had already cancelled.',
  },
] as const;

export type InvoiceLifecycleErrorCode = 'INVALID_TRANSITION';

/** Raised when a caller asks for a move the lifecycle does not allow. */
/**
 * The explanation the API gave for these refusals before the lifecycle table
 * existed. Kept as a second sentence so existing clients matching it still work.
 */
const TRANSITION_REFUSAL_DETAIL: Readonly<Record<string, string>> = {
  PAID: ' The invoice was not found, expired, or already processed.',
  CANCELLED: ' The invoice was not found or already processed.',
};

export class InvalidTransitionError extends Error {
  readonly code: InvoiceLifecycleErrorCode = 'INVALID_TRANSITION';
  readonly from: string;
  readonly to: string;
  readonly event?: InvoiceEvent;

  // Plain fields rather than constructor parameter properties: the frontend
  // loads this file through Node's type stripping, which only erases types.
  constructor(from: string, to: string, event?: InvoiceEvent) {
    super(`Invalid invoice transition: ${from} -> ${to}.${TRANSITION_REFUSAL_DETAIL[to] ?? ''}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.event = event;
  }
}

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

/** The transitions leaving `status`, in table order. */
export function transitionsFrom(status: string): InvoiceTransition[] {
  return INVOICE_TRANSITIONS.filter((transition) => transition.from === status);
}

/** The states reachable from `status` in one step. Empty for terminal states. */
export function allowedTransitions(status: string): InvoiceStatus[] {
  return [...new Set(transitionsFrom(status).map((transition) => transition.to))];
}

export function canTransition(from: string, to: string): boolean {
  return transitionsFrom(from).some((transition) => transition.to === to);
}

/** True when nothing may ever change the invoice's status again. */
export function isTerminalStatus(status: string): boolean {
  return isInvoiceStatus(status) && transitionsFrom(status).length === 0;
}

/**
 * The state `event` leads to from `from`, or `null` when the event is illegal
 * there. This is the deterministic form of the machine: `(state, event)` has at
 * most one answer.
 */
export function nextStatus(from: string, event: InvoiceEvent): InvoiceStatus | null {
  return transitionsFrom(from).find((transition) => transition.event === event)?.to ?? null;
}

/**
 * Returns the target state for `event`, or throws `InvalidTransitionError`.
 * Stores call this immediately before writing so an illegal move is refused the
 * same way regardless of backend.
 */
export function assertTransition(from: string, event: InvoiceEvent): InvoiceStatus {
  const next = nextStatus(from, event);
  if (next === null) {
    throw new InvalidTransitionError(from, targetOf(event), event);
  }
  return next;
}

/** The state an event is aiming at, used to word the error for an illegal move. */
function targetOf(event: InvoiceEvent): InvoiceStatus {
  switch (event) {
    case 'CANCEL':
      return 'CANCELLED';
    case 'EXPIRE':
      return 'EXPIRED';
    case 'SETTLE':
    case 'SETTLE_AFTER_CANCEL':
      return 'PAID';
  }
}

/** Serialisable description of the whole machine, as served by the API. */
export function describeLifecycle() {
  return {
    states: INVOICE_STATUSES.map((status) => ({
      status,
      terminal: isTerminalStatus(status),
      allowedTransitions: allowedTransitions(status),
    })),
    transitions: INVOICE_TRANSITIONS.map(({ from, event, to, description }) => ({
      from,
      event,
      to,
      description,
    })),
  };
}
