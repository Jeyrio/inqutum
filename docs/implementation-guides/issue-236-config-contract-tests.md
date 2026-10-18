# Issue #236: Add Cross-Environment Configuration Contract Tests for Production-Critical Settings

## Problem

Production deployments fail when:
- Required env vars missing
- Contract IDs invalid
- URLs malformed
- Secrets not set
- Network settings inconsistent

**Current gap**: No automated tests validating configuration before deployment.

## Solution

Configuration contract tests that fail fast on invalid settings.

## Test Implementation

**File**: `backend/tests/config-contracts.test.ts`

```typescript
import { describe, it, expect } from '@jest/globals';
import { config } from '../src/config';

describe('Configuration Contract Tests', () => {
  describe('Required Environment Variables', () => {
    it('DATABASE_URL must be set', () => {
      expect(config.DATABASE_URL).toBeDefined();
      expect(config.DATABASE_URL).toMatch(/^postgres:\/\//);
    });

    it('STELLAR_NETWORK must be testnet or mainnet', () => {
      expect(config.STELLAR_NETWORK).toMatch(/^(testnet|mainnet)$/);
    });

    it('JWT_SECRET must be set and sufficiently long', () => {
      expect(config.JWT_SECRET).toBeDefined();
      expect(config.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    });

    it('CONTRACT_ID must be valid Stellar contract address', () => {
      expect(config.CONTRACT_ID).toMatch(/^C[A-Z2-7]{55}$/);
    });
  });

  describe('URL Validation', () => {
    it('API_URL must be valid HTTPS URL in production', () => {
      if (process.env.NODE_ENV === 'production') {
        expect(config.API_URL).toMatch(/^https:\/\//);
      }
    });

    it('HORIZON_URL must be reachable', async () => {
      const response = await fetch(config.HORIZON_URL);
      expect(response.ok).toBe(true);
    });
  });

  describe('Network Consistency', () => {
    it('CONTRACT_ID must match STELLAR_NETWORK', async () => {
      const contractInfo = await fetchContractInfo(config.CONTRACT_ID);
      expect(contractInfo.network).toBe(config.STELLAR_NETWORK);
    });

    it('HORIZON_URL must match STELLAR_NETWORK', () => {
      if (config.STELLAR_NETWORK === 'mainnet') {
        expect(config.HORIZON_URL).toContain('stellar.org');
      } else {
        expect(config.HORIZON_URL).toContain('testnet');
      }
    });
  });

  describe('Secret Security', () => {
    it('JWT_SECRET must not be default value', () => {
      const defaults = ['secret', 'change-me', 'your-secret-here'];
      expect(defaults).not.toContain(config.JWT_SECRET);
    });

    it('DATABASE_URL must not contain default password', () => {
      expect(config.DATABASE_URL).not.toContain('password');
      expect(config.DATABASE_URL).not.toContain('postgres:postgres');
    });
  });

  describe('Production Readiness', () => {
    it('NODE_ENV must be production in production', () => {
      if (process.env.DEPLOY_ENV === 'production') {
        expect(config.NODE_ENV).toBe('production');
      }
    });

    it('Rate limits must be configured', () => {
      expect(config.RATE_LIMIT_MAX_REQUESTS).toBeGreaterThan(0);
      expect(config.RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    });
  });
});
```

## CI Integration

**File**: `.github/workflows/config-validation.yml`

```yaml
name: Configuration Validation

on: [push, pull_request, deployment]

jobs:
  validate-config:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        environment: [development, staging, production]
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Load environment config
        run: |
          if [ "${{ matrix.environment }}" == "production" ]; then
            cp .env.production .env
          else
            cp .env.${{ matrix.environment }} .env
          fi
      
      - name: Run configuration contract tests
        run: npm test -- --testPathPattern=config-contracts
      
      - name: Fail if contract violated
        if: failure()
        run: |
          echo "❌ Configuration contract violated for ${{ matrix.environment }}"
          exit 1
```

## Acceptance Criteria

- [ ] Tests for required env vars
- [ ] Tests for contract IDs validity
- [ ] Tests for URLs reachability
- [ ] Tests for secrets security
- [ ] Tests for network consistency
- [ ] Automated tests
- [ ] CI integration
- [ ] Documentation
