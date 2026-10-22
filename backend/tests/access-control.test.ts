import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  OWNED_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  describeAccessControl,
  isOwnershipScoped,
  permissionsFor,
} from '../../shared/access-control.ts';
import type { Permission, Role } from '../../shared/access-control.ts';
import { WALLET_CHALLENGE_MAX_SECONDS } from '../../shared/wallet-auth.ts';
import { issueSessionToken, verifySessionToken } from '../src/auth/session-token.ts';
import { loadAuthConfig } from '../src/auth/config.ts';
import {
  ChallengeReplayGuard,
  buildWalletChallenge,
  verifyWalletChallenge,
} from '../src/auth/wallet-challenge.ts';
import { createAuthRouter } from '../src/routes/auth.routes.ts';
import { createInvoiceRouter } from '../src/routes/invoice.routes.ts';
import { createPaymentMonitorRouter } from '../src/routes/payment-monitor.routes.ts';
import { createNotificationRouter } from '../src/routes/notification.routes.ts';
import { createQuotaRouter } from '../src/routes/quota.routes.ts';
import { createAnalyticsRouter } from '../src/routes/analytics.routes.ts';
import { QuotaManager } from '../src/domain/quota-management.ts';
import { AnalyticsStore } from '../src/domain/analytics.ts';
import { NotificationService } from '../src/notifications/notification-service.ts';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import {
  MAINTAINER_TOKEN,
  SERVICE_TOKEN,
  TEST_SESSION_SECRET,
  maintainerAuth,
  serviceAuth,
  walletAuth,
} from './fixtures/auth.fixture.ts';

// The code under test logs every request and every rejected call. That output is
// noise here and, at volume, makes the node:test runner's IPC stream flaky
// ("Unable to deserialize cloned data"), so this file keeps it quiet.
for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = () => undefined;
}

const PASSPHRASE = Networks.TESTNET;
const owner = Keypair.random();
const stranger = Keypair.random();

describe('role and permission table', () => {
  // Written out independently of ROLE_PERMISSIONS so the table cannot pass by
  // being compared with itself.
  const EXPECTED: Record<Role, Permission[]> = {
    anonymous: ['lifecycle:read', 'invoice:read', 'invoice:verify', 'invoice:email'],
    end_user: [
      'lifecycle:read',
      'invoice:read',
      'invoice:verify',
      'invoice:create',
      'invoice:list',
      'invoice:stats',
      'invoice:cancel',
      'invoice:audit',
      'invoice:email',
      'invoice:deliveries',
      'stellar:read',
      'notification:preferences:write',
    ],
    maintainer: [
      'lifecycle:read',
      'invoice:read',
      'invoice:verify',
      'invoice:list',
      'invoice:stats',
      'invoice:cancel',
      'invoice:audit',
      'invoice:simulate',
      'invoice:email',
      'invoice:deliveries',
      'email:admin',
      'reconciliation:run',
      'monitor:read',
      'monitor:sync',
      'stellar:read',
      'quota:read',
      'quota:override',
      'analytics:read',
      'analytics:clear',
      'notification:preferences:write',
    ],
    service: [
      'lifecycle:read',
      'invoice:read',
      'invoice:verify',
      'invoice:list',
      'invoice:stats',
      'invoice:audit',
      'invoice:email',
      'invoice:deliveries',
      'email:admin',
      'reconciliation:run',
      'monitor:read',
      'monitor:sync',
      'stellar:read',
      'quota:read',
      'analytics:read',
    ],
  };

  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const allowed = EXPECTED[role].includes(permission);
      it(`${role} ${allowed ? 'may' : 'may not'} ${permission}`, () => {
        assert.equal(can(role, permission), allowed);
      });
    }
  }

  it('denies unknown roles and lists nothing for them', () => {
    assert.equal(can('root', 'invoice:read'), false);
    assert.equal(can('', 'invoice:read'), false);
    assert.deepEqual(permissionsFor('root'), []);
  });

  it('only end users are scoped to their own resources, and only for owned permissions', () => {
    for (const permission of PERMISSIONS) {
      assert.equal(isOwnershipScoped('end_user', permission), OWNED_PERMISSIONS.includes(permission));
      assert.equal(isOwnershipScoped('maintainer', permission), false);
      assert.equal(isOwnershipScoped('service', permission), false);
    }
  });

  it('never lets an anonymous caller do anything that moves or exposes seller data', () => {
    for (const permission of ['invoice:create', 'invoice:list', 'invoice:stats', 'invoice:cancel', 'invoice:audit'] as const) {
      assert.equal(can('anonymous', permission), false);
    }
  });

  it('describes the table for the API', () => {
    const described = describeAccessControl();
    assert.deepEqual(described.roles.map((r) => r.role), [...ROLES]);
    assert.deepEqual(
      described.roles.find((r) => r.role === 'end_user')?.permissions,
      [...ROLE_PERMISSIONS.end_user]
    );
  });
});

describe('session tokens', () => {
  const SECRET = TEST_SESSION_SECRET;
  const wallet = owner.publicKey();

  it('round-trips a wallet and its expiry', () => {
    const { token, claims } = issueSessionToken(SECRET, wallet, { ttlSeconds: 600, nowMs: 1_000_000 });
    const verified = verifySessionToken(SECRET, token, 1_000_000);
    assert.equal(verified?.sub, wallet);
    assert.equal(verified?.exp, claims.exp);
  });

  it('rejects an expired token', () => {
    const { token } = issueSessionToken(SECRET, wallet, { ttlSeconds: 60, nowMs: 1_000_000 });
    assert.equal(verifySessionToken(SECRET, token, 1_000_000 + 61_000), null);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issueSessionToken('another-secret-0123456789-abcdefghijklmn', wallet, { ttlSeconds: 600 });
    assert.equal(verifySessionToken(SECRET, token), null);
  });

  it('rejects a token whose payload was tampered with', () => {
    const { token } = issueSessionToken(SECRET, wallet, { ttlSeconds: 600 });
    const [prefix, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
      sub: stranger.publicKey(),
    })).toString('base64url');
    assert.equal(verifySessionToken(SECRET, `${prefix}.${forged}.${signature}`), null);
  });

  it('rejects malformed tokens', () => {
    for (const token of ['', 'iq1', 'iq1.a', 'iq1.a.b.c', 'xx1.a.b', 'iq1..', 'not a token']) {
      assert.equal(verifySessionToken(SECRET, token), null, token);
    }
  });
});

describe('wallet challenge verification', () => {
  const sign = (xdr: string, keypair: Keypair) => {
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(keypair);
    return tx.toXDR();
  };
  const signed = (keypair = owner, options: { nowMs?: number; validForSeconds?: number } = {}) =>
    sign(buildWalletChallenge(keypair.publicKey(), { networkPassphrase: PASSPHRASE, ...options }), keypair);

  it('accepts a challenge signed by the account it names', () => {
    const result = verifyWalletChallenge(signed(), { networkPassphrase: PASSPHRASE });
    assert.ok(result.ok);
    assert.equal(result.wallet, owner.publicKey());
  });

  it('rejects an unsigned challenge', () => {
    const unsigned = buildWalletChallenge(owner.publicKey(), { networkPassphrase: PASSPHRASE });
    const result = verifyWalletChallenge(unsigned, { networkPassphrase: PASSPHRASE });
    assert.ok(!result.ok && result.code === 'BAD_SIGNATURE');
  });

  it('rejects a challenge signed by a different account (cannot claim someone else\'s wallet)', () => {
    const forged = sign(buildWalletChallenge(owner.publicKey(), { networkPassphrase: PASSPHRASE }), stranger);
    const result = verifyWalletChallenge(forged, { networkPassphrase: PASSPHRASE });
    assert.ok(!result.ok && result.code === 'BAD_SIGNATURE');
  });

  it('rejects an expired challenge and one not yet valid', () => {
    const now = Date.now();
    const old = signed(owner, { nowMs: now - 3_600_000 });
    const expired = verifyWalletChallenge(old, { networkPassphrase: PASSPHRASE, nowMs: now });
    assert.ok(!expired.ok && expired.code === 'CHALLENGE_EXPIRED');

    const future = signed(owner, { nowMs: now + 3_600_000 });
    const early = verifyWalletChallenge(future, { networkPassphrase: PASSPHRASE, nowMs: now });
    assert.ok(!early.ok && early.code === 'CHALLENGE_EXPIRED');
  });

  it('rejects a challenge valid for longer than the maximum window', () => {
    const long = signed(owner, { validForSeconds: WALLET_CHALLENGE_MAX_SECONDS + 1 });
    const result = verifyWalletChallenge(long, { networkPassphrase: PASSPHRASE });
    assert.ok(!result.ok && result.code === 'CHALLENGE_TOO_LONG');
  });

  it('rejects a challenge that is replayed', () => {
    const guard = new ChallengeReplayGuard();
    const xdr = signed();
    assert.ok(verifyWalletChallenge(xdr, { networkPassphrase: PASSPHRASE, replayGuard: guard }).ok);
    const again = verifyWalletChallenge(xdr, { networkPassphrase: PASSPHRASE, replayGuard: guard });
    assert.ok(!again.ok && again.code === 'CHALLENGE_REPLAYED');
  });

  it('rejects a challenge built for a different network', () => {
    const publicNetwork = TransactionBuilder.fromXDR(
      buildWalletChallenge(owner.publicKey(), { networkPassphrase: Networks.PUBLIC }),
      Networks.PUBLIC
    );
    publicNetwork.sign(owner);
    const otherNetwork = publicNetwork.toXDR();
    const result = verifyWalletChallenge(otherNetwork, { networkPassphrase: PASSPHRASE });
    // A signature commits to the network passphrase, so it fails verification here.
    assert.ok(!result.ok);
  });

  it('rejects an ordinary transaction that is not a sign-in challenge', () => {
    const tx = new TransactionBuilder(
      new Account(owner.publicKey(), '100'),
      { fee: '100', networkPassphrase: PASSPHRASE, timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 60 } }
    )
      .addOperation(Operation.payment({
        destination: stranger.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }))
      .build();
    tx.sign(owner);
    const result = verifyWalletChallenge(tx.toXDR(), { networkPassphrase: PASSPHRASE });
    assert.ok(!result.ok && result.code === 'UNSUPPORTED_CHALLENGE');
  });

  it('rejects malformed input without throwing', () => {
    for (const input of [undefined, null, 42, '', 'not-xdr', {}, 'A'.repeat(9000)]) {
      const result = verifyWalletChallenge(input, { networkPassphrase: PASSPHRASE });
      assert.ok(!result.ok && result.code === 'MALFORMED_CHALLENGE', String(input));
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP: every privileged action, every role
// ---------------------------------------------------------------------------

interface Harness {
  baseUrl: string;
  raw: MemoryStorage;
  storage: MemoryInvoiceStorage;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const raw = new MemoryStorage();
  const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthRouter({ enableRateLimiting: false, networkPassphrase: PASSPHRASE }));
  app.use(
    '/api',
    createInvoiceRouter({
      storage,
      allowSimulate: true,
      enableRateLimiting: false,
      enableConcurrencyLock: false,
      enableCeilingCheck: false,
    })
  );
  app.use(
    '/api',
    createPaymentMonitorRouter({
      manualSync: async () => undefined,
      getStatus: () => ({ state: 'running' }),
    } as any)
  );
  app.use(
    '/api',
    createNotificationRouter({
      service: new NotificationService(undefined, undefined, undefined, () => undefined),
    })
  );
  // Fresh stores so the matrix never touches process-wide quota or analytics state.
  app.use('/api', createQuotaRouter(new QuotaManager()));
  app.use('/api', createAnalyticsRouter(new AnalyticsStore()));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    raw,
    storage,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Headers = Record<string, string>;

async function call(
  h: Harness,
  method: string,
  path: string,
  options: { headers?: Headers; body?: unknown } = {}
) {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

describe('access control over HTTP', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  const actors: Record<string, Headers | undefined> = {
    anonymous: undefined,
    owner: walletAuth(owner.publicKey()),
    stranger: walletAuth(stranger.publicKey()),
    maintainer: maintainerAuth(),
    service: serviceAuth(),
  };

  const seedInvoice = () =>
    h.storage.createInvoice({
      amount: 5,
      sellerPublicKey: owner.publicKey(),
      expiresInDays: 7,
    } as any);

  interface Case {
    action: string;
    permission: Permission;
    /** Expected status per actor. */
    expect: Record<keyof typeof actors, number>;
    run(actor: Headers | undefined, invoiceId: string): ReturnType<typeof call>;
  }

  const cases: Case[] = [
    {
      action: 'create an invoice for the owner\'s wallet',
      permission: 'invoice:create',
      expect: { anonymous: 401, owner: 201, stranger: 403, maintainer: 403, service: 403 },
      run: (headers) =>
        call(h, 'POST', '/invoices', {
          headers,
          body: { amount: 3, assetCode: 'XLM', sellerPublicKey: owner.publicKey() },
        }),
    },
    {
      action: 'list the owner\'s invoices',
      permission: 'invoice:list',
      expect: { anonymous: 401, owner: 200, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'GET', `/invoices?sellerPublicKey=${owner.publicKey()}`, { headers }),
    },
    {
      action: 'read the owner\'s stats',
      permission: 'invoice:stats',
      expect: { anonymous: 401, owner: 200, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'GET', `/invoices/stats?sellerPublicKey=${owner.publicKey()}`, { headers }),
    },
    {
      action: 'cancel the owner\'s invoice',
      permission: 'invoice:cancel',
      expect: { anonymous: 401, owner: 200, stranger: 403, maintainer: 200, service: 403 },
      run: (headers, id) => call(h, 'POST', `/invoices/${id}/cancel`, { headers, body: {} }),
    },
    {
      action: 'read the audit trail of the owner\'s invoice',
      permission: 'invoice:audit',
      expect: { anonymous: 401, owner: 200, stranger: 403, maintainer: 200, service: 200 },
      run: (headers, id) => call(h, 'GET', `/invoices/${id}/audit`, { headers }),
    },
    {
      action: 'simulate a payment',
      permission: 'invoice:simulate',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 403 },
      run: (headers, id) => call(h, 'POST', `/invoices/${id}/simulate-payment`, { headers }),
    },
    {
      action: 'read monitor status',
      permission: 'monitor:read',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'GET', '/payment/monitor/status', { headers }),
    },
    {
      action: 'trigger a monitor sync',
      permission: 'monitor:sync',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'POST', '/payment/sync', { headers, body: { limit: 1 } }),
    },
    {
      action: 'inspect quota usage',
      permission: 'quota:read',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'GET', '/quotas', { headers }),
    },
    {
      action: 'reset a quota bucket',
      permission: 'quota:override',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 403 },
      run: (headers) => call(h, 'POST', '/quotas/reset', { headers, body: { actor: 'someone' } }),
    },
    {
      action: 'read the analytics summary',
      permission: 'analytics:read',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 200 },
      run: (headers) => call(h, 'GET', '/analytics/summary', { headers }),
    },
    {
      action: 'clear analytics',
      permission: 'analytics:clear',
      expect: { anonymous: 401, owner: 403, stranger: 403, maintainer: 200, service: 403 },
      run: (headers) => call(h, 'POST', '/analytics/clear', { headers }),
    },
    {
      action: 'change the owner\'s notification preferences',
      permission: 'notification:preferences:write',
      expect: { anonymous: 401, owner: 200, stranger: 403, maintainer: 200, service: 403 },
      run: (headers) =>
        call(h, 'PUT', '/notifications/preferences', {
          headers,
          body: { recipient: owner.publicKey(), categories: { payment_reminder: false } },
        }),
    },
  ];

  it('covers every privileged permission except the ones exercised elsewhere', () => {
    const covered = new Set(cases.map((c) => c.permission));
    const exercisedElsewhere: Permission[] = [
      'lifecycle:read',
      'invoice:read',
      'invoice:verify',
      'invoice:email',
      'invoice:deliveries',
      'email:admin',
      'reconciliation:run',
      'stellar:read',
    ];
    for (const permission of PERMISSIONS) {
      assert.ok(
        covered.has(permission) || exercisedElsewhere.includes(permission),
        `no permission test for ${permission}`
      );
    }
  });

  for (const testCase of cases) {
    describe(`${testCase.action} (${testCase.permission})`, () => {
      for (const [actor, status] of Object.entries(testCase.expect)) {
        it(`${actor} -> ${status}`, async () => {
          const invoice = await seedInvoice();
          const result = await testCase.run(actors[actor], invoice.id);
          assert.equal(result.status, status, JSON.stringify(result.body));

          if (status === 401) {
            assert.equal(result.body.code, 'UNAUTHENTICATED');
          }
          if (status === 403) {
            assert.equal(result.body.code, 'FORBIDDEN');
          }
        });
      }
    });
  }

  it('a denied cancel leaves the invoice untouched, even with the UI bypassed', async () => {
    const invoice = await seedInvoice();
    // Attacker names the owner's key in the body but authenticates as themselves.
    const result = await call(h, 'POST', `/invoices/${invoice.id}/cancel`, {
      headers: actors.stranger,
      body: { sellerPublicKey: owner.publicKey() },
    });
    assert.equal(result.status, 403);
    assert.equal((await h.storage.getInvoiceById(invoice.id))?.status, 'PENDING');
  });

  it('a seller cannot list another seller\'s invoices by editing the query', async () => {
    const result = await call(h, 'GET', `/invoices?sellerPublicKey=${owner.publicKey()}`, {
      headers: actors.stranger,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.data, undefined);
  });

  describe('public routes stay public', () => {
    it('serves the lifecycle model, an invoice and its payment info to anyone', async () => {
      const invoice = await seedInvoice();
      assert.equal((await call(h, 'GET', '/invoices/lifecycle')).status, 200);
      assert.equal((await call(h, 'GET', `/invoices/${invoice.id}`)).status, 200);
      assert.equal((await call(h, 'GET', `/invoices/${invoice.id}/payment-info`)).status, 200);
    });

    it('lets an anonymous payer reach verify (it fails on the missing hash, not on auth)', async () => {
      const invoice = await seedInvoice();
      const result = await call(h, 'POST', `/invoices/${invoice.id}/verify`, { body: {} });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'MISSING_TX_HASH');
    });

    it('treats a bad or expired token on a public route as anonymous instead of failing the payer', async () => {
      const invoice = await seedInvoice();
      const expired = walletAuth(owner.publicKey(), { nowMs: Date.now() - 7_200_000, ttlSeconds: 60 });
      for (const headers of [{ Authorization: 'Bearer garbage' }, expired]) {
        assert.equal((await call(h, 'GET', `/invoices/${invoice.id}`, { headers })).status, 200);
      }
    });
  });

  describe('credentials', () => {
    it('answers 401 with a WWW-Authenticate challenge when a privileged route gets a bad token', async () => {
      const response = await fetch(`${h.baseUrl}/invoices?sellerPublicKey=${owner.publicKey()}`, {
        headers: { Authorization: 'Bearer garbage' },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.match((await response.json() as any).error, /invalid or have expired/);
    });

    it('rejects an expired session on a privileged route', async () => {
      const expired = walletAuth(owner.publicKey(), { nowMs: Date.now() - 7_200_000, ttlSeconds: 60 });
      const result = await call(h, 'GET', `/invoices?sellerPublicKey=${owner.publicKey()}`, { headers: expired });
      assert.equal(result.status, 401);
    });

    it('rejects a non-Bearer Authorization header', async () => {
      const result = await call(h, 'GET', `/invoices?sellerPublicKey=${owner.publicKey()}`, {
        headers: { Authorization: `Basic ${MAINTAINER_TOKEN}` },
      });
      assert.equal(result.status, 401);
    });

    it('does not accept a static token that differs by one character', async () => {
      const result = await call(h, 'GET', '/payment/monitor/status', {
        headers: { Authorization: `Bearer ${MAINTAINER_TOKEN}x` },
      });
      assert.equal(result.status, 401);
    });

    it('does not let a service token stand in for a maintainer', async () => {
      const result = await call(h, 'POST', `/invoices/none/simulate-payment`, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
      assert.equal(result.status, 403);
    });
  });

  describe('router guard coverage', () => {
    const guardsOf = (router: any) =>
      router.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => ({
          route: `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`,
          permission: layer.route.stack.map((s: any) => s.handle.permission).find(Boolean) as string | undefined,
        }));

    it('guards every invoice route with the permission it is documented to need', () => {
      const router = createInvoiceRouter({ storage: h.storage, enableRateLimiting: false });
      assert.deepEqual(guardsOf(router), [
        { route: 'POST /invoices', permission: 'invoice:create' },
        { route: 'GET /invoices/lifecycle', permission: 'lifecycle:read' },
        { route: 'GET /invoices/stats', permission: 'invoice:stats' },
        { route: 'GET /invoices', permission: 'invoice:list' },
        { route: 'GET /invoices/:id', permission: 'invoice:read' },
        { route: 'GET /invoices/:id/payment-info', permission: 'invoice:read' },
        { route: 'GET /invoices/:id/audit', permission: 'invoice:audit' },
        { route: 'POST /invoices/:id/cancel', permission: 'invoice:cancel' },
        { route: 'POST /invoices/:id/verify', permission: 'invoice:verify' },
        { route: 'POST /invoices/:id/simulate-payment', permission: 'invoice:simulate' },
        { route: 'GET /invoices/:id/email-preview', permission: 'invoice:email' },
        { route: 'POST /invoices/:id/send-email', permission: 'invoice:email' },
      ]);
    });

    it('guards every payment monitor route', () => {
      const router = createPaymentMonitorRouter({} as any);
      assert.deepEqual(guardsOf(router), [
        { route: 'POST /payment/sync', permission: 'monitor:sync' },
        { route: 'GET /payment/monitor/status', permission: 'monitor:read' },
      ]);
    });
  });
});

describe('simulate-payment stays hidden when switched off', () => {
  it('answers 404 to everyone, including a maintainer, so the route does not reveal itself', async () => {
    const raw = new MemoryStorage();
    const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw));
    const app = express();
    app.use(express.json());
    app.use('/api', createInvoiceRouter({ storage, allowSimulate: false, enableRateLimiting: false }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const headers of [{}, maintainerAuth(), walletAuth(owner.publicKey())]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/invoices/x/simulate-payment`, {
          method: 'POST',
          headers,
        });
        assert.equal(response.status, 404);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('wallet sign-in endpoint', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  const challenge = (keypair = owner) => {
    const tx = TransactionBuilder.fromXDR(
      buildWalletChallenge(keypair.publicKey(), { networkPassphrase: PASSPHRASE }),
      PASSPHRASE
    );
    tx.sign(keypair);
    return tx.toXDR();
  };

  it('exchanges a signed challenge for a session that authenticates as that wallet', async () => {
    const session = await call(h, 'POST', '/auth/session', { body: { transaction: challenge() } });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.data.role, 'end_user');
    assert.equal(session.body.data.wallet, owner.publicKey());

    const me = await call(h, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${session.body.data.token}` },
    });
    assert.equal(me.body.data.role, 'end_user');
    assert.equal(me.body.data.wallet, owner.publicKey());
    assert.ok(me.body.data.permissions.includes('invoice:cancel'));
  });

  it('issues a session that can then create the wallet\'s own invoice', async () => {
    const session = await call(h, 'POST', '/auth/session', { body: { transaction: challenge(stranger) } });
    const created = await call(h, 'POST', '/invoices', {
      headers: { Authorization: `Bearer ${session.body.data.token}` },
      body: { amount: 1, sellerPublicKey: stranger.publicKey() },
    });
    assert.equal(created.status, 201);
  });

  it('refuses to reuse a challenge', async () => {
    const xdr = challenge();
    assert.equal((await call(h, 'POST', '/auth/session', { body: { transaction: xdr } })).status, 200);
    const replay = await call(h, 'POST', '/auth/session', { body: { transaction: xdr } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'INVALID_WALLET_PROOF');
    assert.equal(replay.body.details.reason, 'CHALLENGE_REPLAYED');
  });

  it('refuses a challenge signed by the wrong key', async () => {
    const tx = TransactionBuilder.fromXDR(
      buildWalletChallenge(owner.publicKey(), { networkPassphrase: PASSPHRASE }),
      PASSPHRASE
    );
    tx.sign(stranger);
    const result = await call(h, 'POST', '/auth/session', { body: { transaction: tx.toXDR() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.details.reason, 'BAD_SIGNATURE');
  });

  it('refuses a request with no transaction', async () => {
    const result = await call(h, 'POST', '/auth/session', { body: {} });
    assert.equal(result.status, 401);
    assert.equal(result.body.details.reason, 'MALFORMED_CHALLENGE');
  });

  it('reports 503 rather than signing with a guessable key when no secret is configured in production', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createAuthRouter({
        enableRateLimiting: false,
        networkPassphrase: PASSPHRASE,
        env: () => ({ NODE_ENV: 'production' }),
      })
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: challenge() }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as any).code, 'SESSION_UNAVAILABLE');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('lists the roles table', async () => {
    const roles = await call(h, 'GET', '/auth/roles');
    assert.equal(roles.status, 200);
    assert.deepEqual(roles.body.data, describeAccessControl());
  });
});

describe('auth configuration', () => {
  it('ignores API tokens too short to be secret', () => {
    const config = loadAuthConfig({ MAINTAINER_API_TOKENS: 'short, ' + 'x'.repeat(30), NODE_ENV: 'test' });
    assert.equal(config.maintainerTokenDigests.length, 1);
  });

  it('never invents a session secret in production', () => {
    assert.equal(loadAuthConfig({ NODE_ENV: 'production' }).sessionSecret, null);
    assert.equal(loadAuthConfig({ NODE_ENV: 'production', AUTH_SESSION_SECRET: 'too-short' }).sessionSecret, null);
    assert.equal(
      loadAuthConfig({ NODE_ENV: 'production', AUTH_SESSION_SECRET: 's'.repeat(32) }).sessionSecret,
      's'.repeat(32)
    );
  });

  it('uses one throwaway secret per process outside production', () => {
    const a = loadAuthConfig({ NODE_ENV: 'development' }).sessionSecret;
    const b = loadAuthConfig({ NODE_ENV: 'development' }).sessionSecret;
    assert.ok(a && a === b);
  });

  it('bounds the session lifetime', () => {
    assert.equal(loadAuthConfig({ NODE_ENV: 'test', AUTH_SESSION_TTL_SECONDS: '10' }).sessionTtlSeconds, 3600);
    assert.equal(loadAuthConfig({ NODE_ENV: 'test', AUTH_SESSION_TTL_SECONDS: '900' }).sessionTtlSeconds, 900);
  });
});
