/**
 * User facing activity timeline (issue #80).
 *
 * Builds a timeline from the invoice audit trail. Each event type has a
 * visibility: `public` events can be shown to the invoice owner, `maintainer`
 * events stay in the operator audit view and never reach a user. Event data is
 * not copied through; each public entry carries only the fields listed for it,
 * so a new field written to the audit trail does not leak by default.
 */
export type TimelineVisibility = 'public' | 'maintainer';

interface EventRule {
  visibility: TimelineVisibility;
  title: string;
  /** Event data keys a user may see. Anything else is dropped. */
  fields: string[];
}

export const TIMELINE_EVENT_RULES: Record<string, EventRule> = {
  INVOICE_CREATED: { visibility: 'public', title: 'Invoice created', fields: ['amount', 'assetCode'] },
  PAYMENT_CONFIRMED: { visibility: 'public', title: 'Payment confirmed', fields: ['txHash', 'amount'] },
  INVOICE_CANCELLED: { visibility: 'public', title: 'Invoice cancelled', fields: [] },
  INVOICE_EXPIRED: { visibility: 'public', title: 'Invoice expired', fields: [] },
  PAYMENT_RECEIVED_AFTER_CANCEL: { visibility: 'public', title: 'Payment received after cancel', fields: ['txHash'] },
  PAYMENT_RECEIVED_AFTER_EXPIRY: { visibility: 'public', title: 'Payment received after expiry', fields: ['txHash'] },
  PAYMENT_REJECTED: { visibility: 'maintainer', title: 'Payment rejected', fields: [] },
  PARTIAL_PAYMENT: { visibility: 'maintainer', title: 'Partial payment', fields: [] },
};

export interface TimelineEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  eventData: Record<string, unknown> | null;
  createdAt: Date | string;
}

export interface TimelineInvoice {
  id: string;
  sellerPublicKey: string;
  /** Deleted or restricted records drop out of the user timeline entirely. */
  deleted?: boolean;
  restricted?: boolean;
}

export interface TimelineViewer {
  role?: string;
  wallet?: string | null;
}

export interface TimelineEntry {
  id: string;
  type: string;
  title: string;
  occurredAt: string;
  invoiceId: string;
  link: string;
  data: Record<string, unknown>;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

export interface TimelineQuery {
  limit?: number;
  cursor?: string | null;
}

export const DEFAULT_TIMELINE_LIMIT = 20;
export const MAX_TIMELINE_LIMIT = 100;

/** Unknown event types are maintainer only until someone classifies them. */
export function visibilityOf(eventType: string): TimelineVisibility {
  return TIMELINE_EVENT_RULES[eventType]?.visibility ?? 'maintainer';
}

function canSee(viewer: TimelineViewer, event: TimelineEvent, invoice: TimelineInvoice | undefined): boolean {
  if (!invoice || invoice.deleted || invoice.restricted) return false;
  if (visibilityOf(event.eventType) !== 'public') return false;
  return Boolean(viewer.wallet) && viewer.wallet === invoice.sellerPublicKey;
}

const timeOf = (value: Date | string): number => {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Newest first; the id breaks ties so two events in the same millisecond keep their order across pages. */
function compare(a: TimelineEvent, b: TimelineEvent): number {
  return timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const encodeCursor = (event: TimelineEvent): string =>
  Buffer.from(JSON.stringify([timeOf(event.createdAt), event.id])).toString('base64url');

function decodeCursor(cursor: string): [number, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string') {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

function toEntry(event: TimelineEvent): TimelineEntry {
  const rule = TIMELINE_EVENT_RULES[event.eventType];
  const data: Record<string, unknown> = {};
  for (const key of rule.fields) {
    if (event.eventData && event.eventData[key] !== undefined) data[key] = event.eventData[key];
  }
  return {
    id: event.id,
    type: event.eventType,
    title: rule.title,
    occurredAt: new Date(timeOf(event.createdAt)).toISOString(),
    invoiceId: event.invoiceId,
    link: `/invoice/${encodeURIComponent(event.invoiceId)}`,
    data,
  };
}

export class InvalidTimelineCursorError extends Error {
  constructor() {
    super('Invalid timeline cursor');
    this.name = 'InvalidTimelineCursorError';
  }
}

export function buildActivityTimeline(
  viewer: TimelineViewer,
  events: TimelineEvent[],
  invoices: TimelineInvoice[],
  query: TimelineQuery = {}
): TimelinePage {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_TIMELINE_LIMIT)), MAX_TIMELINE_LIMIT);
  const byId = new Map(invoices.map((i) => [i.id, i]));

  let visible = events.filter((e) => canSee(viewer, e, byId.get(e.invoiceId))).sort(compare);

  if (query.cursor) {
    const after = decodeCursor(query.cursor);
    if (!after) throw new InvalidTimelineCursorError();
    const [t, id] = after;
    visible = visible.filter((e) => {
      const et = timeOf(e.createdAt);
      return et < t || (et === t && e.id > id);
    });
  }

  const page = visible.slice(0, limit);
  return {
    entries: page.map(toEntry),
    nextCursor: visible.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}
