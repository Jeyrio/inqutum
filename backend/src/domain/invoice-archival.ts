/**
 * Lifecycle-aware archival and restoration (#197).
 *
 * Archival is an explicit lifecycle layer over the invoice, not a soft-delete flag:
 *
 *   ACTIVE --archive--> ARCHIVED --restore--> ACTIVE
 *
 * The invoice's own status (PAID / EXPIRED / CANCELLED) is never rewritten, so
 * receipts, proofs, audit events and dispute links that reference the invoice
 * keep resolving. Archiving only records *who/why/when* and the state it was
 * archived from; restoring checks that nothing changed in the meantime and
 * returns the record to exactly that state.
 *
 * Eligibility (`evaluateArchiveEligibility`) is a pure function of the invoice,
 * the clock and the linked-record summary, and reports every failing rule:
 *
 *   NOT_TERMINAL          only PAID, EXPIRED and CANCELLED invoices can be archived
 *   TOO_RECENT            the terminal state must be at least `minAgeDays` old
 *   OPEN_DISPUTE          an unresolved dispute still references the invoice
 *   ALREADY_ARCHIVED      archiving twice is refused rather than silently ignored
 *
 * See docs/ARCHIVAL.md.
 */
import type { InvoiceStatus, InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';

export const ARCHIVE_LIFECYCLE_STATES = ['ACTIVE', 'ARCHIVED'] as const;
export type ArchiveLifecycleState = (typeof ARCHIVE_LIFECYCLE_STATES)[number];

export const ARCHIVABLE_STATUSES: readonly InvoiceStatus[] = ['PAID', 'EXPIRED', 'CANCELLED'];
export const DEFAULT_MIN_ARCHIVE_AGE_DAYS = 30;

export type ArchiveDenialCode = 'NOT_TERMINAL' | 'TOO_RECENT' | 'OPEN_DISPUTE' | 'ALREADY_ARCHIVED';
export type ArchiveErrorCode =
  | ArchiveDenialCode
  | 'INVOICE_NOT_FOUND'
  | 'NOT_ARCHIVED'
  | 'REASON_REQUIRED'
  | 'ACTOR_REQUIRED'
  | 'STATE_CHANGED_SINCE_ARCHIVE';

export class ArchiveError extends Error {
  constructor(
    public readonly code: ArchiveErrorCode,
    message: string,
    public readonly httpStatus = 409,
    public readonly denials: ArchiveDenial[] = []
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchiveDenial {
  code: ArchiveDenialCode;
  message: string;
}

/** What other records still reference an invoice. Supplied by the caller so this module stays storage-agnostic. */
export interface LinkedRecordSummary {
  openDisputes: number;
  /** Ids of records that must stay resolvable after archival (receipts, disputes, audit events...). */
  references: Array<{ kind: string; id: string }>;
}

export interface ArchiveLinkProvider {
  summarize(invoiceId: string): LinkedRecordSummary | Promise<LinkedRecordSummary>;
}

export const NO_LINKS: ArchiveLinkProvider = { summarize: () => ({ openDisputes: 0, references: [] }) };

export interface ArchiveRecord {
  invoiceId: string;
  state: ArchiveLifecycleState;
  /** Invoice status when archived; restore returns the record to this state. */
  archivedStatus: InvoiceStatus;
  archivedVersion: number | null;
  archivedAt: string;
  archivedBy: string;
  archiveReason: string;
  restoredAt: string | null;
  restoredBy: string | null;
  restoreReason: string | null;
  /** References captured at archive time so audits can follow them without the live record. */
  references: Array<{ kind: string; id: string }>;
  /** Append-only history of archive/restore transitions. */
  history: Array<{ from: ArchiveLifecycleState; to: ArchiveLifecycleState; at: string; actor: string; reason: string }>;
}

export interface ArchiveEligibility {
  eligible: boolean;
  denials: ArchiveDenial[];
}

export interface ArchiveEligibilityInput {
  invoice: Pick<StoredInvoice, 'status' | 'paidAt' | 'cancelledAt' | 'expiresAt' | 'settledAt'>;
  now: Date;
  links: LinkedRecordSummary;
  alreadyArchived?: boolean;
  minAgeDays?: number;
}

/** When the invoice reached its terminal state; null if it has not. */
export function terminalSince(invoice: ArchiveEligibilityInput['invoice']): Date | null {
  const pick = (v: Date | string | undefined | null): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  };
  switch (invoice.status) {
    case 'PAID':
      return pick(invoice.settledAt) ?? pick(invoice.paidAt);
    case 'CANCELLED':
      return pick(invoice.cancelledAt);
    case 'EXPIRED':
      return pick(invoice.expiresAt);
    default:
      return null;
  }
}

export function evaluateArchiveEligibility(input: ArchiveEligibilityInput): ArchiveEligibility {
  const denials: ArchiveDenial[] = [];
  const minAgeDays = input.minAgeDays ?? DEFAULT_MIN_ARCHIVE_AGE_DAYS;

  if (input.alreadyArchived) {
    denials.push({ code: 'ALREADY_ARCHIVED', message: 'Invoice is already archived' });
  }
  if (!ARCHIVABLE_STATUSES.includes(input.invoice.status)) {
    denials.push({
      code: 'NOT_TERMINAL',
      message: `Only ${ARCHIVABLE_STATUSES.join(', ')} invoices can be archived; this one is ${input.invoice.status}`,
    });
  } else {
    const since = terminalSince(input.invoice);
    const ageMs = since ? input.now.getTime() - since.getTime() : -1;
    if (!since || ageMs < minAgeDays * 86_400_000) {
      denials.push({
        code: 'TOO_RECENT',
        message: `Invoice must have been ${input.invoice.status} for at least ${minAgeDays} days before archival`,
      });
    }
  }
  if (input.links.openDisputes > 0) {
    denials.push({ code: 'OPEN_DISPUTE', message: `${input.links.openDisputes} unresolved dispute(s) reference this invoice` });
  }
  return { eligible: denials.length === 0, denials };
}

export interface InvoiceArchiveServiceOptions {
  storage: Pick<InvoiceStorage, 'getInvoiceById'>;
  links?: ArchiveLinkProvider;
  now?: () => Date;
  minAgeDays?: number;
  /** Called after every transition; failures are swallowed so an audit sink cannot undo it. */
  onTransition?: (record: ArchiveRecord, transition: 'ARCHIVED' | 'RESTORED') => void;
}

export interface HistoricalView {
  invoice: StoredInvoice;
  lifecycleState: ArchiveLifecycleState;
  archive: ArchiveRecord | null;
}

const requireText = (value: unknown, code: 'REASON_REQUIRED' | 'ACTOR_REQUIRED', label: string, min = 1): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) {
    throw new ArchiveError(code, min > 1 ? `${label} must be at least ${min} characters` : `${label} is required`, 400);
  }
  return text;
};

export class InvoiceArchiveService {
  private readonly records = new Map<string, ArchiveRecord>();
  private readonly now: () => Date;
  private readonly links: ArchiveLinkProvider;

  constructor(private readonly options: InvoiceArchiveServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.links = options.links ?? NO_LINKS;
  }

  state(invoiceId: string): ArchiveLifecycleState {
    return this.records.get(invoiceId)?.state ?? 'ACTIVE';
  }

  isArchived(invoiceId: string): boolean {
    return this.state(invoiceId) === 'ARCHIVED';
  }

  private async load(invoiceId: string): Promise<StoredInvoice> {
    const invoice = await this.options.storage.getInvoiceById(invoiceId);
    if (!invoice) throw new ArchiveError('INVOICE_NOT_FOUND', 'Invoice not found', 404);
    return invoice;
  }

  /** Read-only: why an invoice can or cannot be archived right now. */
  async checkEligibility(invoiceId: string): Promise<ArchiveEligibility> {
    const invoice = await this.load(invoiceId);
    return evaluateArchiveEligibility({
      invoice,
      now: this.now(),
      links: await this.links.summarize(invoiceId),
      alreadyArchived: this.isArchived(invoiceId),
      minAgeDays: this.options.minAgeDays,
    });
  }

  async archive(invoiceId: string, input: { actor: string; reason: string }): Promise<ArchiveRecord> {
    const actor = requireText(input.actor, 'ACTOR_REQUIRED', 'actor');
    const reason = requireText(input.reason, 'REASON_REQUIRED', 'reason', 10);
    const invoice = await this.load(invoiceId);
    const links = await this.links.summarize(invoiceId);
    const verdict = evaluateArchiveEligibility({
      invoice,
      now: this.now(),
      links,
      alreadyArchived: this.isArchived(invoiceId),
      minAgeDays: this.options.minAgeDays,
    });
    if (!verdict.eligible) {
      throw new ArchiveError(verdict.denials[0].code, verdict.denials.map((d) => d.message).join('; '), 409, verdict.denials);
    }

    const at = this.now().toISOString();
    const previous = this.records.get(invoiceId);
    const record: ArchiveRecord = {
      invoiceId,
      state: 'ARCHIVED',
      archivedStatus: invoice.status,
      archivedVersion: invoice.version ?? null,
      archivedAt: at,
      archivedBy: actor,
      archiveReason: reason,
      restoredAt: null,
      restoredBy: null,
      restoreReason: null,
      references: links.references.map((r) => ({ ...r })),
      history: [...(previous?.history ?? []), { from: 'ACTIVE', to: 'ARCHIVED', at, actor, reason }],
    };
    this.records.set(invoiceId, record);
    this.notify(record, 'ARCHIVED');
    return structuredClone(record);
  }

  async restore(invoiceId: string, input: { actor: string; reason: string }): Promise<ArchiveRecord> {
    const actor = requireText(input.actor, 'ACTOR_REQUIRED', 'actor');
    const reason = requireText(input.reason, 'REASON_REQUIRED', 'reason', 10);
    const existing = this.records.get(invoiceId);
    if (!existing || existing.state !== 'ARCHIVED') {
      throw new ArchiveError('NOT_ARCHIVED', 'Invoice is not archived', 409);
    }
    const invoice = await this.load(invoiceId);
    const versionMoved = existing.archivedVersion !== null && (invoice.version ?? null) !== existing.archivedVersion;
    if (invoice.status !== existing.archivedStatus || versionMoved) {
      throw new ArchiveError(
        'STATE_CHANGED_SINCE_ARCHIVE',
        `Invoice changed while archived (was ${existing.archivedStatus}, now ${invoice.status}); review before restoring`,
        409
      );
    }

    const at = this.now().toISOString();
    const record: ArchiveRecord = {
      ...existing,
      state: 'ACTIVE',
      restoredAt: at,
      restoredBy: actor,
      restoreReason: reason,
      history: [...existing.history, { from: 'ARCHIVED', to: 'ACTIVE', at, actor, reason }],
    };
    this.records.set(invoiceId, record);
    this.notify(record, 'RESTORED');
    return structuredClone(record);
  }

  /** Archived invoices stay fully readable: history, receipts and audits never lose their target. */
  async historicalView(invoiceId: string): Promise<HistoricalView> {
    const invoice = await this.load(invoiceId);
    const archive = this.records.get(invoiceId);
    return {
      invoice,
      lifecycleState: archive?.state ?? 'ACTIVE',
      archive: archive ? structuredClone(archive) : null,
    };
  }

  list(filter: { state?: ArchiveLifecycleState } = {}): ArchiveRecord[] {
    return [...this.records.values()].filter((r) => !filter.state || r.state === filter.state).map((r) => structuredClone(r));
  }

  private notify(record: ArchiveRecord, transition: 'ARCHIVED' | 'RESTORED'): void {
    try {
      this.options.onTransition?.(structuredClone(record), transition);
    } catch {
      // Audit sink failures must not undo a transition that already happened.
    }
  }
}
