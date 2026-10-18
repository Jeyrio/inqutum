/**
 * Dry-run policy evaluator with affected-record previews (#296).
 *
 * Evaluates a proposed business policy against every stored invoice without
 * writing anything, and returns:
 *  - the field-level diff between the current and proposed policy,
 *  - dataset-wide totals (affected by status, by rule, pending volume at risk
 *    per asset identity, sellers with pending invoices at risk),
 *  - one bounded, keyset-paginated page of affected records.
 *
 * "Affected" means: allowed under the current policy, denied under the
 * proposed one. Records are evaluated with the same `evaluateInvoiceRequest`
 * the policy module exposes, so a preview never disagrees with enforcement.
 *
 * Differences from the earlier simulation preview (policy-simulation.ts), which
 * stays unchanged for existing callers:
 *  - Proposals are validated strictly. An unknown field, a typo or an
 *    inconsistent range is a 400, never a silent "no impact".
 *  - The expiry window rules are evaluated too (derived from expiresAt - createdAt).
 *  - The response is bounded. Totals cover the whole dataset; records come one
 *    page at a time. The cursor is bound to the proposal, so it cannot page a
 *    different evaluation.
 *  - Volume is summed in integer stroops and keyed by asset identity
 *    (`XLM` or `CODE:ISSUER`), so look-alike codes from different issuers are
 *    never merged and totals carry no floating-point drift.
 *
 * Complexity for N invoices, A allowed assets, K preview size:
 *   time  O(N·A + N·log K) comparisons, plus O(K) array moves per preview insert;
 *   extra space O(K + S + V) for S sellers and V asset identities at risk.
 *
 * See docs/POLICY_DRY_RUN.md.
 */
import { evaluateInvoiceRequest, type BusinessPolicy, type PolicyCode } from './policy';
import { buildProposedPolicy, type ProposedPolicyInput } from './policy-simulation';
import { scopeHash } from './stable-cursor';
import {
  compareNewestFirst,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  isAfterCursor,
  type InvoiceCursor,
} from '../storage/invoice-cursor';
import { INVOICE_STATUSES, type InvoiceStatus, type StoredInvoice } from '../storage/invoice-storage';
import { formatAssetIdentity, resolveInvoiceAsset } from '../utils/asset-helpers';
import { STROOP_DECIMALS } from '../utils/verify-amount-tolerance';

/** Stellar amounts are signed 64-bit stroop counts: (2^63 - 1) / 10^7. */
export const STELLAR_MAX_AMOUNT = 922_337_203_685.4775807;
/** Stellar asset codes: 1-4 (alphanum4) or 5-12 (alphanum12) characters from a-z, A-Z, 0-9. */
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;
const MAX_ALLOWED_ASSETS = 100;
export const DEFAULT_PREVIEW_LIMIT = 25;
export const MAX_PREVIEW_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const AMOUNT_FIELDS = ['minAmount', 'maxAmount'] as const;
const DAY_FIELDS = ['minExpiryDays', 'maxExpiryDays', 'defaultExpiryDays'] as const;
const PROPOSAL_FIELDS: ReadonlyArray<keyof ProposedPolicyInput> = [...AMOUNT_FIELDS, ...DAY_FIELDS, 'allowedAssets'];

export class PolicyDryRunError extends Error {
  readonly httpStatus = 400;

  constructor(public readonly code: 'INVALID_POLICY_PROPOSAL' | 'INVALID_CURSOR', message: string) {
    super(message);
    this.name = 'PolicyDryRunError';
  }
}

export interface PolicyDryRunRequest {
  currentPolicy: BusinessPolicy;
  proposedPolicy: BusinessPolicy;
  /** Fingerprint of (current, proposed). Identifies the evaluation; binds the cursor. */
  proposalHash: string;
  previewLimit: number;
  after: InvoiceCursor | null;
}

export interface PolicyFieldChange {
  field: keyof ProposedPolicyInput;
  from: number | string[];
  to: number | string[];
}

export interface AffectedRecord {
  invoiceId: string;
  sellerPublicKey: string;
  status: InvoiceStatus;
  amount: number;
  asset: string;
  createdAt: string;
  expiresAt: string;
  proposedOutcome: PolicyCode;
  reason: string;
}

export interface PolicyDryRunReport {
  dryRun: true;
  evaluatedAt: string;
  proposalHash: string;
  currentPolicy: BusinessPolicy;
  proposedPolicy: BusinessPolicy;
  changes: PolicyFieldChange[];
  summary: {
    totalEvaluated: number;
    totalAffected: number;
    affectedByStatus: Record<InvoiceStatus, number>;
    affectedByRule: Partial<Record<PolicyCode, number>>;
    pendingAtRisk: number;
    /** Asset identity -> amount as a 7-decimal string (Horizon's amount format). */
    pendingVolumeAtRisk: Record<string, string>;
    sellersWithPendingAtRisk: number;
  };
  preview: {
    records: AffectedRecord[];
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

const hasAtMostStroopDecimals = (n: number) => Number(n.toFixed(STROOP_DECIMALS)) === n;

function validateProposal(raw: unknown, current: BusinessPolicy): ProposedPolicyInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyDryRunError('INVALID_POLICY_PROPOSAL', 'proposedPolicy must be an object');
  }
  const input = raw as Record<string, unknown>;
  const issues: string[] = [];
  const proposal: ProposedPolicyInput = {};

  for (const key of Object.keys(input)) {
    if (!PROPOSAL_FIELDS.includes(key as keyof ProposedPolicyInput)) issues.push(`unknown field "${key}"`);
  }

  for (const field of AMOUNT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > STELLAR_MAX_AMOUNT || !hasAtMostStroopDecimals(value)) {
      issues.push(`${field} must be a positive amount with at most ${STROOP_DECIMALS} decimals, up to ${STELLAR_MAX_AMOUNT}`);
    } else {
      proposal[field] = value;
    }
  }

  for (const field of DAY_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      issues.push(`${field} must be a whole number of days, at least 1`);
    } else {
      proposal[field] = value;
    }
  }

  if (input.allowedAssets !== undefined) {
    const assets = input.allowedAssets;
    if (!Array.isArray(assets) || assets.length > MAX_ALLOWED_ASSETS || !assets.every((a) => typeof a === 'string' && ASSET_CODE.test(a))) {
      issues.push(`allowedAssets must be an array of up to ${MAX_ALLOWED_ASSETS} Stellar asset codes (1-12 characters a-z, A-Z, 0-9); [] allows any asset`);
    } else {
      // Same normalisation as loadPolicy(), so the preview matches enforcement.
      proposal.allowedAssets = [...new Set(assets.map((a: string) => a.toUpperCase()))];
    }
  }

  if (issues.length === 0 && Object.keys(proposal).length === 0) {
    issues.push('proposedPolicy must change at least one field');
  }
  if (issues.length === 0) {
    const merged = buildProposedPolicy(current, proposal).invoice;
    if (merged.minAmount > merged.maxAmount) issues.push('minAmount must not exceed maxAmount');
    if (!(merged.minExpiryDays <= merged.defaultExpiryDays && merged.defaultExpiryDays <= merged.maxExpiryDays)) {
      issues.push('expiry days must satisfy minExpiryDays <= defaultExpiryDays <= maxExpiryDays');
    }
  }

  if (issues.length > 0) {
    throw new PolicyDryRunError('INVALID_POLICY_PROPOSAL', `Invalid proposedPolicy: ${issues.join('; ')}`);
  }
  return proposal;
}

/** Validates the request body before any record is read. Throws PolicyDryRunError. */
export function parsePolicyDryRunRequest(body: unknown, currentPolicy: BusinessPolicy): PolicyDryRunRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  const proposedPolicy = buildProposedPolicy(currentPolicy, validateProposal(input.proposedPolicy, currentPolicy));
  const proposalHash = scopeHash({ currentPolicy, proposedPolicy });

  const requested = Number(input.previewLimit);
  const previewLimit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PREVIEW_LIMIT)
    : DEFAULT_PREVIEW_LIMIT;

  let after: InvoiceCursor | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    const [hash, position, extra] = typeof input.cursor === 'string' ? input.cursor.split('.') : [];
    after = hash === proposalHash && extra === undefined ? decodeInvoiceCursor(position) : null;
    if (!after) {
      throw new PolicyDryRunError('INVALID_CURSOR', 'cursor is not valid for this proposal; restart from the first page');
    }
  }

  return { currentPolicy, proposedPolicy, proposalHash, previewLimit, after };
}

function diffPolicies(current: BusinessPolicy, proposed: BusinessPolicy): PolicyFieldChange[] {
  return PROPOSAL_FIELDS.flatMap((field) => {
    const from = current.invoice[field];
    const to = proposed.invoice[field];
    const same = Array.isArray(from) && Array.isArray(to) ? from.join(',') === to.join(',') : from === to;
    return same ? [] : [{ field, from: Array.isArray(from) ? [...from] : from, to: Array.isArray(to) ? [...to] : to }];
  });
}

/** Payment window the invoice was created with, in whole days; undefined when unknowable. */
function windowDays(invoice: StoredInvoice): number | undefined {
  const days = Math.round((new Date(invoice.expiresAt).getTime() - new Date(invoice.createdAt).getTime()) / DAY_MS);
  return Number.isFinite(days) && days >= 1 ? days : undefined;
}

const toStroops = (amount: number): bigint | null =>
  Number.isFinite(amount) && amount > 0 && amount <= STELLAR_MAX_AMOUNT ? BigInt(amount.toFixed(STROOP_DECIMALS).replace('.', '')) : null;

const formatStroops = (stroops: bigint): string => {
  const digits = stroops.toString().padStart(STROOP_DECIMALS + 1, '0');
  return `${digits.slice(0, -STROOP_DECIMALS)}.${digits.slice(-STROOP_DECIMALS)}`;
};

type Candidate = { invoice: StoredInvoice; code: PolicyCode; reason: string };

/** Keeps `page` sorted newest first and at most `bound` long. */
function insertBounded(page: Candidate[], item: Candidate, bound: number): void {
  let lo = 0;
  let hi = page.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareNewestFirst(page[mid].invoice, item.invoice) <= 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= bound) return;
  page.splice(lo, 0, item);
  if (page.length > bound) page.pop();
}

/** Pure and read-only: neither the invoices nor the policies are mutated. */
export function evaluatePolicyDryRun(
  invoices: readonly StoredInvoice[],
  request: PolicyDryRunRequest,
  now: Date = new Date()
): PolicyDryRunReport {
  const { currentPolicy, proposedPolicy, previewLimit, after } = request;
  const affectedByStatus = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, 0])) as Record<InvoiceStatus, number>;
  const affectedByRule: Partial<Record<PolicyCode, number>> = {};
  const volume = new Map<string, bigint>();
  const sellers = new Set<string>();
  // One extra slot tells us whether another page exists.
  const page: Candidate[] = [];
  let totalAffected = 0;

  for (const invoice of invoices) {
    const evaluated = { amount: invoice.amount, assetCode: invoice.assetCode, expiresInDays: windowDays(invoice) };
    if (!evaluateInvoiceRequest(evaluated, currentPolicy).allowed) continue;
    const decision = evaluateInvoiceRequest(evaluated, proposedPolicy);
    if (decision.allowed) continue;

    totalAffected += 1;
    affectedByStatus[invoice.status] += 1;
    affectedByRule[decision.code] = (affectedByRule[decision.code] ?? 0) + 1;

    if (invoice.status === 'PENDING') {
      sellers.add(invoice.sellerPublicKey);
      const stroops = toStroops(invoice.amount);
      if (stroops !== null) {
        const asset = formatAssetIdentity(resolveInvoiceAsset(invoice));
        volume.set(asset, (volume.get(asset) ?? 0n) + stroops);
      }
    }

    if (!after || isAfterCursor(invoice, after)) {
      insertBounded(page, { invoice, code: decision.code, reason: decision.message }, previewLimit + 1);
    }
  }

  const hasMore = page.length > previewLimit;
  const records = page.slice(0, previewLimit);
  const last = records.at(-1);

  return {
    dryRun: true,
    evaluatedAt: now.toISOString(),
    proposalHash: request.proposalHash,
    currentPolicy,
    proposedPolicy,
    changes: diffPolicies(currentPolicy, proposedPolicy),
    summary: {
      totalEvaluated: invoices.length,
      totalAffected,
      affectedByStatus,
      affectedByRule,
      pendingAtRisk: affectedByStatus.PENDING,
      pendingVolumeAtRisk: Object.fromEntries([...volume].map(([asset, stroops]) => [asset, formatStroops(stroops)])),
      sellersWithPendingAtRisk: sellers.size,
    },
    preview: {
      records: records.map(({ invoice, code, reason }) => ({
        invoiceId: invoice.id,
        sellerPublicKey: invoice.sellerPublicKey,
        status: invoice.status,
        amount: invoice.amount,
        asset: formatAssetIdentity(resolveInvoiceAsset(invoice)),
        createdAt: new Date(invoice.createdAt).toISOString(),
        expiresAt: new Date(invoice.expiresAt).toISOString(),
        proposedOutcome: code,
        reason,
      })),
      limit: previewLimit,
      hasMore,
      nextCursor: hasMore && last ? `${request.proposalHash}.${encodeInvoiceCursor(last.invoice)}` : null,
    },
  };
}
