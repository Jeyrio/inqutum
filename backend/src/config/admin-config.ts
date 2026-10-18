/**
 * Audited runtime administrative configuration (#292).
 *
 * Administrative configuration is otherwise environment-only, and an
 * environment change leaves no trace in the audit trail. This service is the
 * one place configuration can change at runtime, today limited to overriding
 * the existing feature flags (already evaluated on every check), and every
 * change produces audit evidence.
 *
 * Invariants:
 *  - Evidence first: the CONFIG_CHANGED event is written to the hash-chained
 *    audit store before the change is applied. If it cannot be written, the
 *    change is not applied (503, retryable). There is never a change without
 *    evidence.
 *  - Optimistic concurrency: every change names the `expectedVersion` it was
 *    based on, so two maintainers cannot silently overwrite each other.
 *  - Attribution comes from the capability that authorized the change, not from
 *    the request body.
 *  - A request that changes nothing is a no-op: no version bump, no event.
 *  - Rollback is a forward change: `enabled: null` clears the override and the
 *    environment value applies again. History is never rewritten.
 *
 * Overrides are process-local and reset on restart; the environment stays the
 * durable source of truth. See docs/ADMIN_CONFIG_AUDIT.md.
 */
import { auditStore, type AuditEvent } from '../audit/audit-service';
import {
  FEATURE_FLAGS,
  environmentFeatureValue,
  featureFlagOverrides,
  type FeatureFlag,
} from './feature-flags';

type RecordAudit = (event: Omit<AuditEvent, 'id' | 'timestamp'>) => AuditEvent;

export interface FeatureFlagState {
  flag: FeatureFlag;
  env: string;
  description: string;
  effective: boolean;
  source: 'override' | 'environment';
  override: boolean | null;
}

export interface AdminConfigSnapshot {
  /** Number of applied runtime changes since process start. */
  version: number;
  featureFlags: FeatureFlagState[];
}

export interface FeatureFlagChangeRequest {
  flag: string;
  /** `true`/`false` sets an override; `null` clears it. */
  enabled: unknown;
  reason: unknown;
  expectedVersion: unknown;
  actorId: string;
  capabilityId: string;
  correlationId?: string;
  ip?: string;
  userAgent?: string;
}

export interface ConfigChangeResult {
  changed: boolean;
  version: number;
  flag: FeatureFlagState;
  /** Evidence written for this change; null for a no-op. */
  auditEventId: string | null;
  auditEventHash: string | null;
}

export type AdminConfigErrorCode =
  | 'UNKNOWN_FEATURE_FLAG'
  | 'INVALID_CONFIG_CHANGE'
  | 'CONFIG_VERSION_CONFLICT'
  | 'CONFIG_AUDIT_UNAVAILABLE';

const HTTP_STATUS: Record<AdminConfigErrorCode, number> = {
  UNKNOWN_FEATURE_FLAG: 404,
  INVALID_CONFIG_CHANGE: 400,
  CONFIG_VERSION_CONFLICT: 409,
  CONFIG_AUDIT_UNAVAILABLE: 503,
};

export class AdminConfigError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: AdminConfigErrorCode, message: string) {
    super(message);
    this.name = 'AdminConfigError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface AdminConfigOptions {
  /** Defaults to the process audit store. */
  recordAudit?: RecordAudit;
  /** Defaults to the process feature-flag override layer. */
  overrides?: typeof featureFlagOverrides;
  env?: Record<string, string | undefined>;
}

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

const isFlag = (flag: string): flag is FeatureFlag => Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, flag);

export class AdminConfigService {
  private version = 0;
  private readonly recordAudit: RecordAudit;
  private readonly overrides: typeof featureFlagOverrides;

  constructor(private readonly options: AdminConfigOptions = {}) {
    this.recordAudit = options.recordAudit ?? ((event) => auditStore.recordEvent(event));
    this.overrides = options.overrides ?? featureFlagOverrides;
  }

  private state(flag: FeatureFlag): FeatureFlagState {
    const override = this.overrides.get(flag);
    return {
      flag,
      env: FEATURE_FLAGS[flag].env,
      description: FEATURE_FLAGS[flag].description,
      effective: override ?? environmentFeatureValue(flag, this.options.env ?? process.env),
      source: override === undefined ? 'environment' : 'override',
      override: override ?? null,
    };
  }

  /** O(F) for F declared flags. */
  snapshot(): AdminConfigSnapshot {
    return {
      version: this.version,
      featureFlags: (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map((flag) => this.state(flag)),
    };
  }

  /** O(1) plus one audit append. Synchronous, so no other change can interleave. */
  setFeatureFlag(request: FeatureFlagChangeRequest): ConfigChangeResult {
    if (!isFlag(request.flag)) {
      throw new AdminConfigError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${request.flag}"`);
    }
    if (request.enabled !== null && typeof request.enabled !== 'boolean') {
      throw new AdminConfigError('INVALID_CONFIG_CHANGE', 'enabled must be true, false, or null to clear the override');
    }
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
      throw new AdminConfigError('INVALID_CONFIG_CHANGE', `reason must explain the change (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters)`);
    }
    if (!Number.isSafeInteger(request.expectedVersion) || (request.expectedVersion as number) < 0) {
      throw new AdminConfigError('INVALID_CONFIG_CHANGE', 'expectedVersion must be the current config version (a non-negative integer)');
    }
    if (request.expectedVersion !== this.version) {
      throw new AdminConfigError('CONFIG_VERSION_CONFLICT', `Config is at version ${this.version}, not ${request.expectedVersion}; re-read it and retry`);
    }

    const flag = request.flag;
    const before = this.state(flag);
    const enabled = request.enabled as boolean | null;
    if (before.override === enabled) {
      return { changed: false, version: this.version, flag: before, auditEventId: null, auditEventHash: null };
    }

    const nextVersion = this.version + 1;
    const after = {
      enabled: enabled ?? environmentFeatureValue(flag, this.options.env ?? process.env),
      source: enabled === null ? 'environment' : 'override',
      override: enabled,
      configVersion: nextVersion,
    };

    let evidence: AuditEvent;
    try {
      evidence = this.recordAudit({
        action: 'CONFIG_CHANGED',
        actor: { type: 'maintainer', id: request.actorId, ip: request.ip, userAgent: request.userAgent },
        scope: { entityType: 'config', entityId: `featureFlags.${flag}` },
        reason,
        beforeState: { enabled: before.effective, source: before.source, override: before.override, configVersion: this.version },
        afterState: after,
        metadata: {
          configKey: `featureFlags.${flag}`,
          envVar: before.env,
          change: enabled === null ? 'override_cleared' : 'override_set',
          capabilityId: request.capabilityId,
        },
        correlationId: request.correlationId,
      });
    } catch {
      throw new AdminConfigError('CONFIG_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the change was not applied; retry');
    }

    this.overrides.set(flag, enabled);
    this.version = nextVersion;
    return { changed: true, version: nextVersion, flag: this.state(flag), auditEventId: evidence.id, auditEventHash: evidence.hash ?? null };
  }
}

export const adminConfig = new AdminConfigService();
