# Issue #235: Implement Privacy-Preserving Audit Evidence Bundles for Support Investigations

## Problem

Support investigations need access to:
- Transaction logs
- Payment proofs  
- User actions
- System state

**Current gap**: No way to export evidence that:
- Redacts PII/secrets
- Preserves verification hashes
- Maintains timestamps
- Includes enough IDs to trace behavior

## Solution

Create exportable audit bundles with selective redaction.

## Bundle Structure

```typescript
// audit-bundle.ts
export interface AuditEvidence Bundle {
  bundleId: string;
  generatedAt: string;
  investigation: {
    ticketId: string;
    requestedBy: string;  // Support agent ID
    reason: string;
  };
  invoice: {
    id: string;
    idHash: string;  // SHA256 for verification
    createdAt: string;
    amount: string;
    amountHash: string;
    asset: string;
    status: string;
    memoHash: string;  // Redacted memo, only hash
  };
  payment: {
    txHash: string;
    timestamp: string;
    amountHash: string;  // Verify without exposing
    signatureHash: string;  // Verify integrity
  };
  user: {
    idHash: string;  // No email/name
    createdAt: string;
    role: string;
  };
  events: Array<{
    timestamp: string;
    action: string;
    outcomeHash: string;
  }>;
}

export class AuditBundleGenerator {
  /**
   * Generate privacy-preserving bundle for investigation
   */
  async generate(invoiceId: string, reason: string): Promise<AuditEvidenceBundle> {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { user: true, payments: true } });
    
    return {
      bundleId: randomUUID(),
      generatedAt: new Date().toISOString(),
      investigation: {
        ticketId: 'TKT-XXX',
        requestedBy: 'support-agent-id',
        reason,
      },
      invoice: {
        id: invoice.id,
        idHash: sha256(invoice.id),
        createdAt: invoice.createdAt.toISOString(),
        amount: invoice.amount,
        amountHash: sha256(invoice.amount),
        asset: invoice.asset,
        status: invoice.status,
        memoHash: sha256(invoice.memo),  // REDACT actual memo
      },
      payment: invoice.payments[0] ? {
        txHash: invoice.payments[0].txHash,
        timestamp: invoice.payments[0].timestamp.toISOString(),
        amountHash: sha256(invoice.payments[0].amount),
        signatureHash: sha256(invoice.payments[0].signature),  // REDACT signature
      } : null,
      user: {
        idHash: sha256(invoice.userId),  // REDACT email/name
        createdAt: invoice.user.createdAt.toISOString(),
        role: invoice.user.role,
      },
      events: await this.getAuditEvents(invoiceId),
    };
  }

  private async getAuditEvents(invoiceId: string) {
    const events = await prisma.auditLog.findMany({
      where: { resourceId: invoiceId },
      orderBy: { timestamp: 'asc' },
    });

    return events.map(e => ({
      timestamp: e.timestamp.toISOString(),
      action: e.action,
      outcomeHash: sha256(e.outcome),  // Hash outcome, don't expose details
    }));
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
```

## CLI Tool

```bash
# Generate bundle
npm run audit-bundle generate INV-123 "Customer reported payment not credited"

# Verify bundle integrity
npm run audit-bundle verify bundle-xyz.json

# Validate hashes
npm run audit-bundle validate bundle-xyz.json --invoice=INV-123
```

## Acceptance Criteria

- [ ] Redacts email, name, wallet addresses
- [ ] Preserves hashes for verification
- [ ] Includes timestamps and IDs
- [ ] Automated tests
- [ ] Documentation
- [ ] Rollback procedures
