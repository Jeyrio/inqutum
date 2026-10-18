/**
 * Versioned event replay for rebuilding projections (#290).
 *
 * Rebuilds the search-index projection from the audit trail instead of copying
 * it from storage (#269 does that). Replaying is what proves the event log can
 * reproduce the projection; a log that cannot is reported, never swapped in.
 *
 *   1. Snapshot the events, oldest first, and verify the hash chain.
 *   2. Fold them through a *versioned* projector into a fresh shadow index.
 *      The live index is not touched while this runs.
 *   3. Carry over state that is not event-sourced (visibility) and overlay
 *      lazy expiry, which this system never records as an event.
 *   4. Verify the shadow against storage with the #269 detector.
 *   5. Dry run (default): report only. Apply: swap the shadow in with one
 *      synchronous replace, keeping the previous index for a one-step rollback.
 *
 * Projector versions are immutable: changing how events map to records means
 * adding version N+1, so a report always names the logic that produced it.
 */

import { hashEvent, type AuditAction, type AuditEvent } from '../audit/audit-service';
import { INVOICE_STATUSES, type InvoiceStorage, type StoredInvoice } from '../storage/invoice-storage';
import { PermissionAwareSearchIndex, type IndexedInvoiceRecord } from '../services/search-index.service';
import { StaleProjectionService, type ProjectionAnomalyType } from './stale-projections.service';

export interface Projector {
  version: number;
  /** Actions this version understands. Any other action is skipped and counted. */
  handles: ReadonlySet<AuditAction>;
  /** Applies one event; returns false when its payload cannot be projected. */
  apply(index: PermissionAwareSearchIndex, event: AuditEvent): boolean;
}

function isInvoiceSnapshot(value: unknown, id: string): value is StoredInvoice {
  const s = value as Record<string, unknown> | null | undefined;
  return (
    !!s &&
    s.id === id &&
    typeof s.sellerPublicKey === 'string' &&
    typeof s.amount === 'number' &&
    typeof s.assetCode === 'string' &&
    typeof s.memo === 'string' &&
    (INVOICE_STATUSES as readonly unknown[]).includes(s.status)
  );
}

/** v1: every invoice lifecycle event carries the full post-transition invoice in `afterState`. */
const SEARCH_INDEX_V1: Projector = {
  version: 1,
  handles: new Set<AuditAction>([
    'INVOICE_CREATED',
    'INVOICE_CANCELLED',
    'INVOICE_EXPIRED',
    'PAYMENT_VERIFIED',
    'PAYMENT_SIMULATED',
  ]),
  apply(index, event) {
    if (event.scope.entityType !== 'invoice' || !isInvoiceSnapshot(event.afterState, event.scope.entityId)) return false;
    index.indexInvoice(event.afterState);
    return true;
  },
};

export const SEARCH_INDEX_PROJECTORS: ReadonlyMap<number, Projector> = new Map([[1, SEARCH_INDEX_V1]]);
export const LATEST_SEARCH_INDEX_PROJECTOR = Math.max(...SEARCH_INDEX_PROJECTORS.keys());

export interface ChainIntegrity {
  valid: boolean;
  /** The oldest retained event links to one that was evicted. */
  truncated: boolean;
  brokenAt: string | null;
}

/**
 * Checks each event's hash and its link to the one before. Unlike
 * MemoryAuditStore.verifyChain it does not require the first link to be null,
 * so an evicted prefix is reported as truncation rather than tampering. O(E).
 */
export function verifyEventChain(events: readonly AuditEvent[]): ChainIntegrity {
  for (let i = 0; i < events.length; i += 1) {
    const { hash, ...unhashed } = events[i]!;
    const linked = i === 0 || (events[i]!.previousHash ?? null) === (events[i - 1]!.hash ?? null);
    if (!linked || hash !== hashEvent(unhashed)) {
      return { valid: false, truncated: false, brokenAt: events[i]!.id };
    }
  }
  return { valid: true, truncated: (events[0]?.previousHash ?? null) !== null, brokenAt: null };
}

export interface ReplayRequest {
  dryRun?: boolean;
  projectorVersion?: number;
}

export interface ReplayReport {
  projection: 'search_index';
  projectorVersion: number;
  outcome: 'dry_run' | 'applied' | 'refused';
  /** Why the shadow is not safe to swap in. Empty when it is. */
  reasons: string[];
  events: {
    total: number;
    applied: number;
    skipped: number;
    rejected: number;
    firstEventId: string | null;
    lastEventId: string | null;
  };
  integrity: ChainIntegrity;
  /** PENDING records overlaid as EXPIRED from storage (expiry is lazy, not an event). */
  derivedExpiries: number;
  verification: { anomalies: number; byType: Record<ProjectionAnomalyType, number> };
  /** Shadow compared with the live index it would replace. */
  diff: { added: number; removed: number; changed: number };
  startedAt: string;
  completedAt: string;
}

export class ReplayInProgressError extends Error {
  constructor() {
    super('A projection replay is already running');
    this.name = 'ReplayInProgressError';
  }
}

export class UnknownProjectorVersionError extends Error {
  constructor(version: unknown) {
    super(`Unknown projector version ${String(version)}; known: ${[...SEARCH_INDEX_PROJECTORS.keys()].join(', ')}`);
    this.name = 'UnknownProjectorVersionError';
  }
}

export class NothingToRollBackError extends Error {
  constructor() {
    super('No applied replay to roll back');
    this.name = 'NothingToRollBackError';
  }
}

const COMPARED: readonly (keyof IndexedInvoiceRecord)[] = [
  'sellerPublicKey',
  'customerEmail',
  'amount',
  'assetCode',
  'description',
  'memo',
  'status',
  'visibility',
  'isDeleted',
];

function diffIndexes(live: readonly IndexedInvoiceRecord[], shadow: readonly IndexedInvoiceRecord[]): ReplayReport['diff'] {
  const liveById = new Map(live.map((record) => [record.id, record]));
  let added = 0;
  let changed = 0;
  for (const record of shadow) {
    const current = liveById.get(record.id);
    if (!current) added += 1;
    else if (COMPARED.some((field) => current[field] !== record[field])) changed += 1;
    liveById.delete(record.id);
  }
  return { added, removed: liveById.size, changed };
}

export interface ProjectionReplayOptions {
  storage: InvoiceStorage;
  index: PermissionAwareSearchIndex;
  /** Events oldest first. */
  events: () => AuditEvent[];
  now?: () => Date;
}

export class ProjectionReplayService {
  private running = false;
  private previous: IndexedInvoiceRecord[] | null = null;
  private readonly now: () => Date;
  private readonly detector = new StaleProjectionService();

  constructor(private readonly options: ProjectionReplayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * O(E + n) time for E events and n invoices; O(n) extra space for the shadow
   * index (plus the previous index kept for rollback after an apply).
   */
  async replay(request: ReplayRequest = {}): Promise<ReplayReport> {
    const version = request.projectorVersion ?? LATEST_SEARCH_INDEX_PROJECTOR;
    const projector = SEARCH_INDEX_PROJECTORS.get(version);
    if (!projector) throw new UnknownProjectorVersionError(version);
    if (this.running) throw new ReplayInProgressError();
    this.running = true;
    try {
      return await this.run(projector, request.dryRun ?? true);
    } finally {
      this.running = false;
    }
  }

  /** Restores the index that the last applied replay replaced. O(n). */
  rollback(): { restored: number } {
    if (!this.previous) throw new NothingToRollBackError();
    this.options.index.replaceAll(this.previous);
    const restored = this.previous.length;
    this.previous = null;
    return { restored };
  }

  private async run(projector: Projector, dryRun: boolean): Promise<ReplayReport> {
    const startedAt = this.now().toISOString();
    const events = this.options.events();
    const integrity = verifyEventChain(events);

    const shadow = new PermissionAwareSearchIndex();
    let applied = 0;
    let skipped = 0;
    let rejected = 0;
    for (const event of events) {
      if (!projector.handles.has(event.action)) skipped += 1;
      else if (projector.apply(shadow, event)) applied += 1;
      else rejected += 1;
    }

    // Visibility is set by operators, not by events: keep what the live index has.
    const live = this.options.index.exportRecords();
    for (const record of live) shadow.setVisibility(record.id, record.visibility);

    const invoices = this.options.storage.getAllInvoices ? await this.options.storage.getAllInvoices() : [];
    let derivedExpiries = 0;
    const projected = new Map(shadow.exportRecords().map((record) => [record.id, record]));
    for (const invoice of invoices) {
      if (invoice.status === 'EXPIRED' && projected.get(invoice.id)?.status === 'PENDING') {
        shadow.indexInvoice(invoice);
        derivedExpiries += 1;
      }
    }

    const verification = await this.detector.detect(this.options.storage, shadow);
    const reasons: string[] = [];
    if (!integrity.valid) reasons.push(`audit hash chain is broken at event ${integrity.brokenAt}`);
    if (integrity.truncated) reasons.push('the oldest events were evicted from the audit store, so history is incomplete');
    if (rejected > 0) reasons.push(`${rejected} event(s) could not be projected by version ${projector.version}`);
    if (verification.totalAnomalies > 0) {
      reasons.push(`replayed projection disagrees with storage on ${verification.totalAnomalies} record(s)`);
    }

    const rebuilt = shadow.exportRecords();
    const outcome: ReplayReport['outcome'] = dryRun ? 'dry_run' : reasons.length > 0 ? 'refused' : 'applied';
    if (outcome === 'applied') {
      this.previous = live;
      this.options.index.replaceAll(rebuilt);
    }

    return {
      projection: 'search_index',
      projectorVersion: projector.version,
      outcome,
      reasons,
      events: {
        total: events.length,
        applied,
        skipped,
        rejected,
        firstEventId: events[0]?.id ?? null,
        lastEventId: events[events.length - 1]?.id ?? null,
      },
      integrity,
      derivedExpiries,
      verification: { anomalies: verification.totalAnomalies, byType: verification.anomaliesByType },
      diff: diffIndexes(live, rebuilt),
      startedAt,
      completedAt: this.now().toISOString(),
    };
  }
}
