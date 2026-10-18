-- Quittance Database Schema
-- PostgreSQL Database
--
-- Identity is the connected Freighter wallet: every invoice is keyed by
-- seller_public_key. There is no user/email login table.
--
-- Full parity column set (kept in sync with backend/types StoredInvoice via
-- db/migrate.ts + InvoiceService INSERT/SELECT column lists):
--   seller_name, seller_email
--   amount, asset_code, asset_issuer   (credit assets always require both)
--   memo, description
--   customer_name, customer_email
--   status, payment_tx_hash
--   payer_public_key, payer_name, payer_email, paid_at, cancelled_at
--   settled_at, settlement_context, prior_status, late_payment_warning_code
--   created_at, expires_at             (expires_at NOT NULL, default 7d)
--   metadata (JSONB)

-- Invoices Table
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_public_key VARCHAR(56) NOT NULL,
  seller_name VARCHAR(255),
  seller_email VARCHAR(255),
  amount DECIMAL(20, 7) NOT NULL,
  asset_code VARCHAR(12) DEFAULT 'XLM',
  asset_issuer VARCHAR(56),
  memo TEXT UNIQUE NOT NULL,
  description TEXT,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')),
  payment_tx_hash VARCHAR(64),
  payer_public_key VARCHAR(56),
  payer_name VARCHAR(255),
  payer_email VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  settlement_context VARCHAR(20) CHECK (settlement_context IN ('ON_TIME', 'AFTER_EXPIRY', 'AFTER_CANCEL')),
  prior_status VARCHAR(20) CHECK (prior_status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')),
  late_payment_warning_code VARCHAR(50) CHECK (late_payment_warning_code IN ('PAYMENT_RECEIVED_AFTER_EXPIRY', 'PAYMENT_RECEIVED_AFTER_CANCEL')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  metadata JSONB
);

-- Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  from_address VARCHAR(56) NOT NULL,
  to_address VARCHAR(56) NOT NULL,
  amount DECIMAL(20, 7) NOT NULL,
  asset_code VARCHAR(12) DEFAULT 'XLM',
  asset_issuer VARCHAR(56),
  tx_hash VARCHAR(64) UNIQUE NOT NULL,
  memo TEXT,
  ledger BIGINT,
  processed_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

-- Payment Events Log
CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id),
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Background jobs (see docs/JOBS.md): durable queue with retry + dead-letter state.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_policy JSONB NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  locked_by VARCHAR(100),
  idempotency_key VARCHAR(255),
  correlation_id VARCHAR(100),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(run_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);

-- Recovery checkpoints around external side effects (#289, docs/RECOVERY_CHECKPOINTS.md).
-- One row per idempotency key: intent is written before the call, outcome after.
CREATE TABLE IF NOT EXISTS side_effect_checkpoints (
  key VARCHAR(255) PRIMARY KEY,
  effect VARCHAR(100) NOT NULL,
  -- SHA-256 of the request payload: a key reused for another payload is refused.
  fingerprint VARCHAR(64),
  state VARCHAR(20) NOT NULL
    CHECK (state IN ('started', 'succeeded', 'failed', 'in_doubt')),
  attempt INTEGER NOT NULL DEFAULT 1,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_side_effect_checkpoints_open
  ON side_effect_checkpoints(updated_at) WHERE state IN ('started', 'in_doubt');

-- Resumable record repair checkpoints for orphaned and inconsistent records.
CREATE TABLE IF NOT EXISTS record_repair_checkpoints (
  id VARCHAR(64) PRIMARY KEY,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
  phase VARCHAR(50) NOT NULL,
  cursor TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  batch_size INTEGER NOT NULL DEFAULT 100,
  phases JSONB NOT NULL DEFAULT '[]'::jsonb,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_repair_checkpoints_status
  ON record_repair_checkpoints(status, updated_at DESC);

-- Wallet alignment: databases created before wallet-scoped sellers still have
-- the unused users table and invoices.user_id column. Both are dropped here so
-- re-running the migration converges on the wallet-only schema.
ALTER TABLE invoices DROP COLUMN IF EXISTS user_id;
DROP TABLE IF EXISTS users CASCADE;

-- Converge databases created before optimistic concurrency was added.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Converge databases created before invoices carried a caller-supplied external
-- identifier. Bulk imports (#53) key idempotency on this column: a re-run of
-- the same file must not create a second invoice for the same source record.
-- NULL for rows created through the API, which generates its own memo, and NULL
-- rows are excluded from the unique index so an unbounded number of them can
-- coexist.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external_id
  ON invoices(external_id) WHERE external_id IS NOT NULL;

-- Enforce global uniqueness of verified transaction hashes at the database layer (#19).
-- Excludes NULL payment_tx_hash so multiple unpaid/pending invoices can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_payment_tx_hash
  ON invoices(payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;

-- Converge databases created before expiry became an enforced lifecycle.
UPDATE invoices
SET expires_at = COALESCE(created_at, NOW()) + INTERVAL '7 days'
WHERE expires_at IS NULL;
ALTER TABLE invoices ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '7 days';
ALTER TABLE invoices ALTER COLUMN expires_at SET NOT NULL;

-- Converge databases created before deterministic cancel/payment settlement.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS settlement_context VARCHAR(20);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS prior_status VARCHAR(20);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS late_payment_warning_code VARCHAR(50);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_settlement_context_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_settlement_context_check
  CHECK (settlement_context IS NULL OR settlement_context IN ('ON_TIME', 'AFTER_EXPIRY', 'AFTER_CANCEL'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_prior_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_prior_status_check
  CHECK (prior_status IS NULL OR prior_status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_late_payment_warning_code_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_late_payment_warning_code_check
  CHECK (
    late_payment_warning_code IS NULL OR
    late_payment_warning_code IN ('PAYMENT_RECEIVED_AFTER_EXPIRY', 'PAYMENT_RECEIVED_AFTER_CANCEL')
  );

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_invoices_seller ON invoices(seller_public_key);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_asset_code ON invoices(asset_code);
CREATE INDEX IF NOT EXISTS idx_invoices_memo ON invoices(memo);
-- Bulk import idempotency (issue #53). Import rows may carry an externalId
-- supplied by the caller own system; it is the key a re-import matches on so
-- repeating a file does not create a second invoice. Nullable, and unique only
-- where present, so ordinary invoices created through the API are unaffected.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external_id ON invoices(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_seller_created_at ON invoices(seller_public_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_pending_expiry ON invoices(expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
-- One Stellar transaction settles at most one invoice (issue #14). The database,
-- not just the in-process claim index, refuses a second invoice carrying the same
-- payment_tx_hash, even across instances and restarts. Partial: pending, expired
-- and cancelled invoices have no hash and never collide. If an older database
-- already holds duplicates, stop with a readable message instead of a bare index
-- error; those rows are double-settlements and must be resolved by hand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invoices WHERE payment_tx_hash IS NOT NULL
    GROUP BY payment_tx_hash HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'invoices.payment_tx_hash has duplicates; resolve them before applying idx_invoices_payment_tx_hash_unique';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_payment_tx_hash_unique
  ON invoices(payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_invoice_id ON transactions(invoice_id);

-- Sample view for invoice statistics
CREATE OR REPLACE VIEW invoice_stats AS
SELECT
  seller_public_key,
  COUNT(*) as total_invoices,
  SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) as paid_invoices,
  SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending_invoices,
  SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as actionable_invoices,
  SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_invoices,
  SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END) as total_revenue,
  asset_code
FROM invoices
GROUP BY seller_public_key, asset_code;

-- Email Deliveries Table (Phase E queue & anti-spam)
CREATE TABLE IF NOT EXISTS email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255) NOT NULL,
  sender_wallet VARCHAR(56) NOT NULL,
  email_type VARCHAR(50) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'PERMANENTLY_FAILED', 'PAUSED')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  is_retryable BOOLEAN NOT NULL DEFAULT TRUE,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_invoice ON email_deliveries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_sender ON email_deliveries(sender_wallet);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_pending ON email_deliveries(status, next_attempt_at) WHERE status = 'PENDING';

