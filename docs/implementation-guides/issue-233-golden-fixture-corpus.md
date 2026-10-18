# Issue #233: Add Golden Fixture Corpus for Malformed External Payloads and Adversarial Records

## Problem Statement

Inqutum processes external data from:
- Stellar blockchain transactions (payment proofs)
- Merchant input (invoice creation, memo fields)
- Webhook callbacks (payment notifications)
- CSV imports (bulk invoice creation)
- API requests (external integrations)

**Current gap**: No systematic test corpus for malformed, adversarial, or edge-case inputs that could cause:
- Signature verification bypass
- Schema validation escape
- Replay attacks
- Resource exhaustion (oversized payloads)
- Schema drift breakage

## Solution Overview

Create a comprehensive golden fixture corpus with:
1. Known-malformed payloads covering all attack vectors
2. Automated test suite verifying correct rejection
3. Documentation of failure modes and recovery steps

## Fixture Categories

### 1. Payment Proof Manipulation

**File**: `backend/tests/fixtures/malformed-payment-proofs/`

```typescript
// invalid-signature.json
{
  "description": "Payment proof with invalid Ed25519 signature",
  "fixture": {
    "txHash": "abc123...",
    "memo": "INV-001",
    "amount": "100.00",
    "asset": "USDC",
    "signature": "000000...invalid",
    "timestamp": "2024-01-01T00:00:00Z"
  },
  "expectedError": "INVALID_SIGNATURE",
  "threat": "Attacker forges payment proof to mark unpaid invoice as settled"
}

// replay-attack.json
{
  "description": "Valid payment proof reused for different invoice",
  "fixture": {
    "txHash": "def456...",  // Already used for INV-001
    "memo": "INV-002",       // Trying to reuse for different invoice
    "amount": "100.00",
    "asset": "USDC",
    "signature": "valid_sig...",
    "timestamp": "2024-01-01T00:00:00Z"
  },
  "expectedError": "TRANSACTION_ALREADY_USED",
  "threat": "Attacker replays valid payment to settle multiple invoices"
}

// amount-mismatch.json
{
  "description": "Payment proof amount doesn't match invoice amount",
  "fixture": {
    "txHash": "ghi789...",
    "memo": "INV-003",
    "amount": "50.00",       // Invoice requires 100.00
    "asset": "USDC",
    "signature": "valid_sig...",
    "timestamp": "2024-01-01T00:00:00Z"
  },
  "expectedError": "AMOUNT_MISMATCH",
  "threat": "Partial payment marked as full settlement"
}

// missing-fields.json
{
  "description": "Payment proof missing required fields",
  "fixture": {
    "txHash": "jkl012...",
    "memo": "INV-004"
    // Missing: amount, asset, signature, timestamp
  },
  "expectedError": "MISSING_REQUIRED_FIELDS",
  "threat": "Incomplete data causes undefined behavior"
}

// oversized-memo.json
{
  "description": "Memo field exceeds max length (DoS)",
  "fixture": {
    "txHash": "mno345...",
    "memo": "A".repeat(100000),  // Way over limit
    "amount": "100.00",
    "asset": "USDC",
    "signature": "valid_sig...",
    "timestamp": "2024-01-01T00:00:00Z"
  },
  "expectedError": "MEMO_TOO_LONG",
  "threat": "Resource exhaustion via oversized fields"
}

// schema-drift.json
{
  "description": "Future schema version with unknown fields",
  "fixture": {
    "version": "2.0",        // Current version is 1.0
    "txHash": "pqr678...",
    "memo": "INV-005",
    "amount": "100.00",
    "asset": "USDC",
    "signature": "valid_sig...",
    "timestamp": "2024-01-01T00:00:00Z",
    "newFieldV2": "unknown"  // Field doesn't exist in v1 schema
  },
  "expectedError": "UNSUPPORTED_SCHEMA_VERSION",
  "threat": "Schema evolution breaks payment verification"
}
```

### 2. Invoice Creation Malformed Input

**File**: `backend/tests/fixtures/malformed-invoices/`

```typescript
// xss-attempt.json
{
  "description": "Invoice description with XSS payload",
  "fixture": {
    "description": "<script>alert('xss')</script>",
    "amount": "100.00",
    "asset": "USDC",
    "memo": "INV-006"
  },
  "expectedError": "INVALID_CHARACTERS",
  "threat": "XSS attack via invoice description rendering"
}

// sql-injection.json
{
  "description": "Invoice memo with SQL injection attempt",
  "fixture": {
    "description": "Test invoice",
    "amount": "100.00",
    "asset": "USDC",
    "memo": "'; DROP TABLE invoices; --"
  },
  "expectedError": "INVALID_MEMO_FORMAT",
  "threat": "SQL injection via memo field"
}

// negative-amount.json
{
  "description": "Invoice with negative amount",
  "fixture": {
    "description": "Test invoice",
    "amount": "-100.00",
    "asset": "USDC",
    "memo": "INV-007"
  },
  "expectedError": "AMOUNT_MUST_BE_POSITIVE",
  "threat": "Negative amounts could cause accounting errors"
}

// excessive-precision.json
{
  "description": "Amount with too many decimal places",
  "fixture": {
    "description": "Test invoice",
    "amount": "100.123456789",  // Over 7 decimals (Stellar stroops)
    "asset": "USDC",
    "memo": "INV-008"
  },
  "expectedError": "EXCESSIVE_DECIMAL_PRECISION",
  "threat": "Precision loss in amount conversion"
}
```

### 3. Webhook Callback Manipulation

**File**: `backend/tests/fixtures/malformed-webhooks/`

```typescript
// invalid-hmac.json
{
  "description": "Webhook with invalid HMAC signature",
  "fixture": {
    "event": "payment.completed",
    "invoiceId": "inv_123",
    "amount": "100.00",
    "signature": "invalid_hmac..."
  },
  "expectedError": "INVALID_WEBHOOK_SIGNATURE",
  "threat": "Spoofed webhook from attacker"
}

// timestamp-replay.json
{
  "description": "Webhook with old timestamp (replay attack)",
  "fixture": {
    "event": "payment.completed",
    "invoiceId": "inv_124",
    "amount": "100.00",
    "timestamp": "2020-01-01T00:00:00Z",  // Very old
    "signature": "valid_hmac..."
  },
  "expectedError": "TIMESTAMP_TOO_OLD",
  "threat": "Replay of old valid webhook"
}
```

### 4. CSV Import Malformed Data

**File**: `backend/tests/fixtures/malformed-csv-imports/`

```csv
// csv-bomb.csv (DoS via large file)
description,amount,asset,memo
"Line 1","100","USDC","INV-001"
"Line 2","100","USDC","INV-002"
... (millions of rows to exhaust memory)

// malformed-encoding.csv (Invalid UTF-8)
description,amount,asset,memo
"\xFF\xFE Invalid UTF-8","100","USDC","INV-003"

// missing-headers.csv
"No headers row","100","USDC","INV-004"
"Data starts immediately","200","USDC","INV-005"
```

## Test Implementation

**File**: `backend/tests/golden-fixtures.test.ts`

```typescript
import { describe, it, expect } from '@jest/globals';
import { PaymentProofVerifier } from '../src/services/paymentProofVerifier';
import { InvoiceService } from '../src/services/invoiceService';
import { WebhookVerifier } from '../src/services/webhookVerifier';
import { glob } from 'glob';
import { readFileSync } from 'fs';

describe('Golden Fixture Corpus - Malformed Payment Proofs', () => {
  const verifier = new PaymentProofVerifier();
  
  // Load all fixtures from directory
  const fixtureFiles = glob.sync('tests/fixtures/malformed-payment-proofs/*.json');
  
  fixtureFiles.forEach(file => {
    const fixture = JSON.parse(readFileSync(file, 'utf8'));
    
    it(`should reject: ${fixture.description}`, async () => {
      await expect(
        verifier.verify(fixture.fixture)
      ).rejects.toThrow(fixture.expectedError);
    });
  });
});

describe('Golden Fixture Corpus - Malformed Invoices', () => {
  const service = new InvoiceService();
  
  const fixtureFiles = glob.sync('tests/fixtures/malformed-invoices/*.json');
  
  fixtureFiles.forEach(file => {
    const fixture = JSON.parse(readFileSync(file, 'utf8'));
    
    it(`should reject: ${fixture.description}`, async () => {
      await expect(
        service.create(fixture.fixture)
      ).rejects.toThrow(fixture.expectedError);
    });
  });
});

describe('Golden Fixture Corpus - Malformed Webhooks', () => {
  const verifier = new WebhookVerifier();
  
  const fixtureFiles = glob.sync('tests/fixtures/malformed-webhooks/*.json');
  
  fixtureFiles.forEach(file => {
    const fixture = JSON.parse(readFileSync(file, 'utf8'));
    
    it(`should reject: ${fixture.description}`, async () => {
      await expect(
        verifier.verify(fixture.fixture)
      ).rejects.toThrow(fixture.expectedError);
    });
  });
});

// CSV Import tests
describe('Golden Fixture Corpus - Malformed CSV Imports', () => {
  const importer = new CSVImporter();
  
  it('should reject CSV bomb (file too large)', async () => {
    const csvBomb = 'tests/fixtures/malformed-csv-imports/csv-bomb.csv';
    
    await expect(
      importer.import(csvBomb)
    ).rejects.toThrow('FILE_TOO_LARGE');
  });
  
  it('should reject malformed encoding', async () => {
    const malformedCSV = 'tests/fixtures/malformed-csv-imports/malformed-encoding.csv';
    
    await expect(
      importer.import(malformedCSV)
    ).rejects.toThrow('INVALID_ENCODING');
  });
});
```

## Failure Modes Documentation

**File**: `docs/SECURITY_FAILURE_MODES.md`

```markdown
# Security Failure Modes and Recovery

## Payment Proof Verification Failures

### Invalid Signature
**Failure**: Payment proof signature doesn't match transaction data
**Detection**: INVALID_SIGNATURE error during verification
**Impact**: Attacker cannot forge payment proofs
**Recovery**: Request valid payment proof from payer
**Monitoring**: Alert on repeated failures from same account

### Replay Attack
**Failure**: Transaction hash already used for different invoice
**Detection**: TRANSACTION_ALREADY_USED error
**Impact**: Prevents double-spending of single payment
**Recovery**: 
  1. Check original invoice that used this transaction
  2. If legitimate, request new payment from payer
  3. If fraud attempt, flag account for review
**Monitoring**: Alert on patterns of replay attempts

### Amount Mismatch
**Failure**: Paid amount doesn't match invoice amount
**Detection**: AMOUNT_MISMATCH error
**Impact**: Prevents partial payments marked as full settlement
**Recovery**:
  1. Manual review of transaction amount
  2. If underpaid, request remaining balance
  3. If overpaid, process refund or credit
**Monitoring**: Dashboard for mismatched payments

## Invoice Creation Failures

### XSS/SQL Injection Attempts
**Failure**: Malicious code in invoice fields
**Detection**: INVALID_CHARACTERS error during validation
**Impact**: Prevents code execution and data breaches
**Recovery**: Reject invoice, sanitize input, log security event
**Monitoring**: Alert security team on injection attempts

### Negative/Invalid Amounts
**Failure**: Amount validation fails
**Detection**: AMOUNT_MUST_BE_POSITIVE error
**Impact**: Prevents accounting errors
**Recovery**: Reject invoice, return validation error to user
**Monitoring**: Track validation failure rates

## Webhook Verification Failures

### Invalid HMAC
**Failure**: Webhook signature doesn't match payload
**Detection**: INVALID_WEBHOOK_SIGNATURE error
**Impact**: Prevents spoofed webhooks
**Recovery**: Ignore webhook, log security event
**Monitoring**: Alert on patterns from same source

### Timestamp Replay
**Failure**: Webhook timestamp too old
**Detection**: TIMESTAMP_TOO_OLD error
**Impact**: Prevents replay attacks
**Recovery**: Ignore webhook if duplicate, otherwise investigate
**Monitoring**: Alert on replay patterns

## Rollback Procedures

### False Positive: Legitimate Payment Rejected
**Steps**:
1. Review error logs and fixture that triggered rejection
2. Verify payment proof manually on blockchain explorer
3. If legitimate, add exception or update validation logic
4. Manually mark invoice as paid with admin override
5. Document incident for future reference

### Schema Drift: New Fields Breaking Old Code
**Steps**:
1. Identify schema version causing breakage
2. Add backward compatibility layer
3. Update fixtures with new schema examples
4. Deploy hotfix with compatibility code
5. Plan migration for next release
```

## CI Integration

**File**: `.github/workflows/golden-fixtures.yml`

```yaml
name: Golden Fixture Corpus Tests

on: [push, pull_request]

jobs:
  test-fixtures:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run golden fixture tests
        run: npm test -- --testPathPattern=golden-fixtures
      
      - name: Verify all fixtures covered
        run: |
          # Ensure every fixture has corresponding test
          FIXTURES=$(find backend/tests/fixtures -name '*.json' | wc -l)
          TESTS=$(grep -r "should reject" backend/tests/golden-fixtures.test.ts | wc -l)
          
          if [ $FIXTURES -ne $TESTS ]; then
            echo "ERROR: Fixture count ($FIXTURES) doesn't match test count ($TESTS)"
            exit 1
          fi
```

## Acceptance Criteria Checklist

- [ ] Fixtures covering invalid signatures
- [ ] Fixtures covering missing fields
- [ ] Fixtures covering oversized values (DoS)
- [ ] Fixtures covering replay attacks
- [ ] Fixtures covering schema drift
- [ ] Automated test suite for all fixtures
- [ ] Documentation of failure modes
- [ ] Rollback/recovery procedures documented
- [ ] CI integration validates fixtures on every PR
- [ ] Compatible with existing public APIs

## Future Enhancements

- Fuzz testing generator for random malformed inputs
- Metrics dashboard for rejection patterns
- Automated security report generation
- Integration with security scanning tools
