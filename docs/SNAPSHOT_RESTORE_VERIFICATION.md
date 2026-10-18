# Snapshot Restore Verification for Critical Data and Derived Indexes (#263)

## Purpose & Scope
When recovering from disaster recovery (DR) snapshots, automated database backups, or point-in-time point recovery, ensuring an exit code of `0` is insufficient. Restores must be verified against relational, financial, and temporal invariants, and derived projections (search indexes, revenue aggregates, and status distributions) must be rebuilt from restored truth.

Mismatches must fail loudly and provide operators with deterministic triage and remediation instructions.

---

## Verified Invariant Families

### 1. Identifier & Relational Invariants
- **Primary Identifier Integrity**: Every invoice, transaction, and payment event must possess a valid, non-empty primary key. Duplicate IDs trigger `CORRUPTED_IDENTIFIER`.
- **Foreign Key / Orphan Containment**:
  - All transactions carrying `invoice_id` must resolve to an extant invoice in storage truth.
  - All payment events carrying `invoice_id` must resolve to an invoice.
  - Detached or orphaned entries trigger `ORPHANED_RELATION`.
- **Settlement Memo Uniqueness**: Two invoices cannot share a settlement memo. A collision triggers `DUPLICATE_MEMO`.

### 2. Status & Temporal Coherence
- **Settlement Invariants**:
  - Invoices marked `PAID` must record both `paidAt` and `paymentTxHash`.
  - Non-paid invoices (`PENDING`, `EXPIRED`, `CANCELLED`) must have a null `paidAt`. Violations trigger `STATUS_INCOHERENCE`.
- **Temporal Invariants**:
  - `expiresAt` must strictly succeed `createdAt`.
  - Violations trigger `TEMPORAL_ANOMALY`.

### 3. Financial Invariants
- **Amount & Asset Integrity**: Invoice amounts must be finite, strictly positive numbers, with valid Stellar asset codes.
- **Settlement Parity**: When an on-chain transaction is linked to an invoice, `transaction.amount` must match `invoice.amount`. Mismatches trigger `FINANCIAL_MISMATCH`.

### 4. Derived View Rebuilding & Drift Detection
The verification engine automatically reconstructs derived views directly from snapshot records:
- **PermissionAwareSearchIndex**: Re-indexed for role-based discovery and query matching.
- **Aggregate Statistics**: Re-calculated for `totalInvoices`, status counts, and `revenueByAsset`.
- If a pre-existing derived index snapshot is provided, the verifier computes drift:
  - Missing records in projection
  - Orphaned records in projection
  - Status/attribute desynchronization
  - Violations trigger `DERIVED_INDEX_DRIFT`.

---

## CLI & Programmatic Usage

### Running the Verifier CLI
```bash
# Verify dry-run against active storage
npm run db:validate-snapshot

# Verify a specific restored snapshot JSON package
npx tsx src/db/validate-snapshot-restore.ts --file /path/to/snapshot.json
```

### Programmatic Integration
```typescript
import {
  verifySnapshotRestore,
  formatSnapshotVerificationReport,
} from './src/db/snapshot-restore-verification';

const report = verifySnapshotRestore({
  invoices: restoredInvoices,
  transactions: restoredTransactions,
  payment_events: restoredEvents,
});

if (!report.ok) {
  console.error(formatSnapshotVerificationReport(report));
  throw new Error('Snapshot verification failed');
}
```

---

## Operational Edge Cases & Failure Modes

| Edge Case | Impact | Remediation Step |
|---|---|---|
| Paid invoice restored without `paidAt` timestamp | Accounting reports cannot determine settlement timing | Cross-reference `paymentTxHash` against Stellar Horizon and backfill timestamp. |
| Incomplete snapshot with missing invoices referenced by transactions | Transaction history detached | Restore missing invoices from secondary archive or link transaction by memo. |
| Search index contains records purged in snapshot | Stale search results displayed to sellers | Call `defaultSearchIndex.purge(id)` or execute `repairStaleIndex()`. |
| Memo conflict from concurrent pre-incident creations | Multiple invoices listening for single memo | Renumber pending invoice and generate new unique memo. |
