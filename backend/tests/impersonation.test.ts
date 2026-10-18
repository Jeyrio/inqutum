import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuditStore } from '../src/audit/audit-service';
import {
  ImpersonationService,
  DEFAULT_SESSION_DURATION_MS,
  MAX_SESSION_DURATION_MS,
  type ImpersonationPermission,
} from '../src/audit/impersonation';

const MAINTAINER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SELLER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('Scoped maintainer impersonation (Issue #76)', () => {
  let audit: MemoryAuditStore;
  let clock: number;
  let service: ImpersonationService;

  beforeEach(() => {
    audit = new MemoryAuditStore(500);
    audit.clear();
    clock = 1_700_000_000_000;
    service = new ImpersonationService({
      now: () => clock,
      audit,
      randomId: (() => {
        let n = 0;
        return () => `imp_test_${n++}`;
      })(),
    });
  });

  const start = (permissions: ImpersonationPermission[] = ['read']) =>
    service.startSession({
      maintainerId: MAINTAINER,
      targetId: SELLER,
      permissions,
      reason: 'User reported missing invoice (ticket SUP-42)',
    });

  describe('Allowed sessions', () => {
    it('allows a scoped read action inside an active session', () => {
      const session = start();
      const decision = service.authorize({ maintainerId: MAINTAINER, action: 'invoice.read' });

      assert.equal(decision.allowed, true);
      assert.equal(decision.code, 'ALLOWED');
      assert.equal(decision.sessionId, session.id);
    });

    it('grants only the requested permissions', () => {
      const session = start(['read', 'export']);
      assert.deepEqual(session.permissions.sort(), ['export', 'read']);
      assert.equal(session.permissions.includes('elevated'), false);
    });

    it('allows an elevated action when the session is elevated and confirmed', () => {
      start(['read', 'elevated']);
      const decision = service.authorize({
        maintainerId: MAINTAINER,
        action: 'invoice.cancel',
        elevatedConfirmation: true,
      });
      assert.equal(decision.allowed, true);
    });
  });

  describe('Denied sessions', () => {
    it('denies every action when no session is active', () => {
      const decision = service.authorize({ maintainerId: MAINTAINER, action: 'invoice.read' });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'NO_ACTIVE_SESSION');
    });

    it('blocks irreversible mutations without the elevated permission', () => {
      start(['read']);
      const decision = service.authorize({ maintainerId: MAINTAINER, action: 'invoice.cancel' });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'ELEVATION_REQUIRED');
    });

    it('blocks an elevated action that skips the confirmation step', () => {
      start(['read', 'elevated']);
      const decision = service.authorize({ maintainerId: MAINTAINER, action: 'payment.verify' });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'ELEVATION_REQUIRED');
    });

    it('never permits actions that would escalate the session itself', () => {
      start(['read', 'elevated']);
      for (const action of ['impersonation.start', 'impersonation.elevate']) {
        const decision = service.authorize({
          maintainerId: MAINTAINER,
          action,
          elevatedConfirmation: true,
        });
        assert.equal(decision.allowed, false);
        assert.equal(decision.code, 'NEVER_ALLOWED');
      }
    });

    it('denies a second maintainer while another session is active', () => {
      start();
      const other = service.authorize({ maintainerId: SELLER, action: 'invoice.read' });
      assert.equal(other.allowed, false);
    });

    it('refuses to start without a justification', () => {
      assert.throws(
        () =>
          service.startSession({
            maintainerId: MAINTAINER,
            targetId: SELLER,
            reason: '   ',
          }),
        /justification is required/i,
      );
    });

    it('refuses self-impersonation and unknown permissions', () => {
      assert.throws(
        () =>
          service.startSession({
            maintainerId: MAINTAINER,
            targetId: MAINTAINER,
            reason: 'self',
          }),
        /cannot impersonate yourself/i,
      );
      assert.throws(
        () =>
          service.startSession({
            maintainerId: MAINTAINER,
            targetId: SELLER,
            permissions: ['root' as ImpersonationPermission],
            reason: 'bad perm',
          }),
        /unknown impersonation permission/i,
      );
    });
  });

  describe('Expiry', () => {
    it('closes a session once it passes its time limit', () => {
      start();
      clock += DEFAULT_SESSION_DURATION_MS + 1;

      const decision = service.authorize({ maintainerId: MAINTAINER, action: 'invoice.read' });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'SESSION_EXPIRED');
      assert.equal(service.getActiveSession(MAINTAINER), null);
    });

    it('caps a requested duration at the hard maximum', () => {
      const session = service.startSession({
        maintainerId: MAINTAINER,
        targetId: SELLER,
        reason: 'long debugging session',
        durationMs: MAX_SESSION_DURATION_MS * 10,
      });
      const ttl =
        new Date(session.expiresAt).getTime() - new Date(session.startedAt).getTime();
      assert.equal(ttl, MAX_SESSION_DURATION_MS);
    });

    it('reports expired sessions through purgeExpired', () => {
      const session = start();
      assert.deepEqual(service.purgeExpired(), []);

      clock += DEFAULT_SESSION_DURATION_MS + 1;
      assert.deepEqual(service.purgeExpired(), [session.id]);
    });
  });

  describe('Auditing', () => {
    it('records start, allowed and blocked actions with the impersonated target', () => {
      start(['read']);
      service.authorize({ maintainerId: MAINTAINER, action: 'invoice.read' });
      service.authorize({ maintainerId: MAINTAINER, action: 'payment.refund' });

      const { events } = audit.queryEvents({ actorType: 'maintainer', limit: 50 });
      const actions = events.map((e) => e.action).reverse();

      assert.ok(actions.includes('IMPERSONATION_STARTED'));
      assert.ok(actions.includes('IMPERSONATION_ACTION_ALLOWED'));
      assert.ok(actions.includes('IMPERSONATION_ACTION_BLOCKED'));

      const started = events.find((e) => e.action === 'IMPERSONATION_STARTED');
      assert.equal(started?.metadata?.impersonatedId, SELLER);
      assert.match(String(started?.reason), /SUP-42/);
    });

    it('audits manual termination and refuses a second close', () => {
      const session = start();
      assert.equal(service.endSession(session.id, MAINTAINER), true);
      assert.equal(service.endSession(session.id, MAINTAINER), false);

      const ended = audit.queryEvents({ action: 'IMPERSONATION_ENDED', limit: 10 });
      assert.equal(ended.total, 1);
      assert.equal(ended.events[0].metadata?.impersonatedId, SELLER);
    });

    it('audits expiry with the reason recorded', () => {
      start();
      clock += DEFAULT_SESSION_DURATION_MS + 1;
      service.getActiveSession(MAINTAINER);

      const expired = audit.queryEvents({ action: 'IMPERSONATION_EXPIRED', limit: 10 });
      assert.equal(expired.total, 1);
    });

    it('does not let one maintainer close another maintainer session', () => {
      const session = start();
      assert.equal(service.endSession(session.id, SELLER), false);
    });
  });

  describe('Visible indicator', () => {
    it('is inactive with no session', () => {
      assert.deepEqual(service.indicator(MAINTAINER), { active: false });
    });

    it('exposes banner copy naming the target and expiry', () => {
      const session = start();
      const indicator = service.indicator(MAINTAINER);

      assert.equal(indicator.active, true);
      assert.equal(indicator.session?.id, session.id);
      assert.match(String(indicator.banner), new RegExp(SELLER));
      assert.match(String(indicator.banner), /expires/i);
    });

    it('drops to inactive once the session ends', () => {
      const session = start();
      service.endSession(session.id, MAINTAINER);
      assert.equal(service.indicator(MAINTAINER).active, false);
    });
  });
});
