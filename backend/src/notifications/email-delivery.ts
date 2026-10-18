/**
 * Email delivery hardening for the invoice / proof email flow (#35).
 *
 * The failure this replaces is a fire-and-forget `mailto:` link: the browser's
 * mail client handles delivery, so the app has no idea whether a freelancer's
 * "Send invoice" actually reached the client. This module makes delivery an
 * explicit, observable operation:
 *
 *  - every attempt is recorded with a terminal status (`sent`, `failed`,
 *    `bounced`, `complained`) so nothing disappears silently,
 *  - provider failures are classified so **auth** and **quota** problems are
 *    reported distinctly from generic/transient ones (the freelancer sees
 *    "your provider rejected our credentials", not "email failed"),
 *  - transient failures are retried with backoff; permanent ones are not,
 *  - bounces and complaints are ingested (webhook or manual) and surfaced
 *    rather than ignored.
 *
 * The transport is pluggable. `createHttpApiTransport` talks to a
 * transactional provider over HTTPS with no extra dependency; `createSmtpTransport`
 * adapts any nodemailer-compatible client. See docs/EMAIL_DELIVERY.md for the
 * DNS (SPF/DKIM/DMARC) setup the chosen domain requires.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  checkOutboundUrl,
  checkPublicDestination,
  type AddressLookup,
  type AllowListViolation,
  type OutboundUrlPolicy,
} from '../security/allow-list';
import {
  CheckpointInDoubtError,
  CheckpointInProgressError,
  CheckpointKeyReusedError,
  MemoryCheckpointStore,
  fingerprintOf,
  runWithCheckpoint,
  type CheckpointStore,
} from '../recovery/side-effect-checkpoint';

export type EmailStatus = 'sent' | 'failed' | 'bounced' | 'complained';

/** Why a send failed, kept distinct so the UI can give specific guidance. */
export type EmailFailureCategory =
  | 'auth'
  | 'quota'
  | 'transient'
  | 'permanent'
  | 'invalid_recipient'
  | 'config'
  /** Another send with the same idempotency key is running (#289). */
  | 'in_progress'
  /** A previous send stopped mid-call; an operator must confirm the outcome (#289). */
  | 'in_doubt'
  /** The idempotency key was already used for a different message (#289). */
  | 'key_reused';

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  /** Suppresses duplicate sends on retry; the store keys deliveries by it. */
  idempotencyKey?: string;
  /** Free-form context (invoice id, asset, amount) recorded with the attempt. */
  metadata?: Record<string, string | number>;
}

export interface EmailTransportResult {
  providerMessageId?: string;
  accepted?: string[];
  rejected?: string[];
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailTransportResult>;
}

export interface EmailDeliveryRecord {
  id: string;
  to: string;
  subject: string;
  status: EmailStatus;
  category?: EmailFailureCategory;
  provider: string;
  providerMessageId?: string;
  /** Raw provider status/code, kept for triage. */
  providerCode?: string;
  attempts: number;
  errorMessage?: string;
  metadata?: Record<string, string | number>;
  createdAt: string;
  updatedAt: string;
  bouncedAt?: string;
  complainedAt?: string;
}

export interface EmailDeliveryResult {
  /** Explicit terminal state — callers must not assume success. */
  status: EmailStatus;
  ok: boolean;
  delivery?: EmailDeliveryRecord;
  category?: EmailFailureCategory;
  retryable?: boolean;
  message?: string;
}

/** Error raised by a transport, classified into an actionable category. */
export class EmailDeliveryError extends Error {
  readonly category: EmailFailureCategory;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    message: string,
    category: EmailFailureCategory,
    options: { retryable?: boolean; providerCode?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidRecipient(address: string | undefined | null): boolean {
  return typeof address === 'string' && EMAIL_RE.test(address.trim());
}

/**
 * Maps a provider failure onto a category. Handles the shapes real providers
 * throw: HTTP status codes, provider string codes (`unauthorized`,
 * `TooManyRequests`, `DailyLimitExceeded`), and plain Error messages.
 */
export function classifyProviderError(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;

  const message = error instanceof Error ? error.message : String(error ?? 'Unknown provider error');
  const code =
    (error as { code?: string; status?: number; statusCode?: number })?.code ??
    (error as { status?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  const haystack = `${code ?? ''} ${message}`.toLowerCase();
  // Providers report limits as a single camelCase token (`TooManyRequests`,
  // `DailyLimitExceeded`), which lowercases to a run-together string that no
  // spaced phrase can match. Compare against a separator-free form as well.
  const compact = haystack.replace(/[^a-z0-9]/g, '');

  if (haystack.includes('unauthorized') || haystack.includes('forbidden') || /\b(401|403)\b/.test(haystack)) {
    return new EmailDeliveryError(message, 'auth', {
      retryable: false,
      providerCode: String(code ?? ''),
      cause: error,
    });
  }
  if (
    haystack.includes('quota') ||
    haystack.includes('rate limit') ||
    haystack.includes('too many requests') ||
    haystack.includes('daily limit') ||
    compact.includes('toomanyrequests') ||
    compact.includes('ratelimit') ||
    compact.includes('quotaexceeded') ||
    compact.includes('dailylimitexceeded') ||
    /\b429\b/.test(haystack)
  ) {
    return new EmailDeliveryError(message, 'quota', {
      // Quota errors can clear, so a bounded retry is reasonable.
      retryable: true,
      providerCode: String(code ?? ''),
      cause: error,
    });
  }
  if (haystack.includes('not configured') || haystack.includes('missing api key') || haystack.includes('no transport')) {
    return new EmailDeliveryError(message, 'config', { retryable: false, cause: error });
  }
  if (
    haystack.includes('invalid recipient') ||
    haystack.includes('invalid address') ||
    haystack.includes('does not exist') ||
    haystack.includes('mailbox unavailable') ||
    /\b(400|404|422)\b/.test(haystack)
  ) {
    return new EmailDeliveryError(message, 'invalid_recipient', {
      retryable: false,
      providerCode: String(code ?? ''),
      cause: error,
    });
  }
  // SMTP splits its reply codes from HTTP's: 4xx is "try again later", 5xx is a
  // permanent rejection (550 mailbox unavailable, 551/552/553/554). Both look
  // like an HTTP 5xx to `/\b5\d\d\b/`, so they must be separated or a permanent
  // rejection burns every retry before surfacing.
  const SMTP_PERMANENT = /\b(550|551|552|553|554|555)\b/;
  if (SMTP_PERMANENT.test(haystack)) {
    return new EmailDeliveryError(message, 'permanent', { retryable: false, providerCode: String(code ?? ''), cause: error });
  }
  if (
    /\b5\d\d\b/.test(haystack) ||
    /\b(421|450|451|452)\b/.test(haystack) ||
    haystack.includes('timeout') ||
    haystack.includes('econnreset') ||
    haystack.includes('socket hang up')
  ) {
    return new EmailDeliveryError(message, 'transient', {
      retryable: true,
      providerCode: String(code ?? ''),
      cause: error,
    });
  }
  return new EmailDeliveryError(message, 'permanent', { retryable: false, providerCode: String(code ?? ''), cause: error });
}

/** Bounded, in-memory delivery log. Backs bounce/complaint visibility. */
export class MemoryEmailDeliveryStore {
  private readonly records = new Map<string, EmailDeliveryRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly maxCapacity = 2000) {}

  record(input: Omit<EmailDeliveryRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): EmailDeliveryRecord {
    const now = new Date().toISOString();
    const existing = input.id ? this.records.get(input.id) : undefined;
    const record: EmailDeliveryRecord = {
      ...input,
      id: input.id ?? uuidv4(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (this.records.size >= this.maxCapacity) {
      const oldest = Array.from(this.records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) {
        this.records.delete(oldest.id);
        this.byIdempotencyKey.delete(oldest.id);
      }
    }

    this.records.set(record.id, record);
    if (record.metadata?.idempotencyKey) {
      this.byIdempotencyKey.set(String(record.metadata.idempotencyKey), record.id);
    }
    return record;
  }

  /** Terminal delivery states a provider webhook can move a record into. */
  markBounced(providerMessageId: string, reason?: string): EmailDeliveryRecord | null {
    const record = this.findByProviderMessageId(providerMessageId);
    if (!record) return null;
    const updated = this.record({
      ...record,
      status: 'bounced',
      category: 'permanent',
      errorMessage: reason ?? record.errorMessage,
      bouncedAt: new Date().toISOString(),
    });
    return updated;
  }

  markComplained(providerMessageId: string, reason?: string): EmailDeliveryRecord | null {
    const record = this.findByProviderMessageId(providerMessageId);
    if (!record) return null;
    return this.record({
      ...record,
      status: 'complained',
      category: 'permanent',
      errorMessage: reason ?? record.errorMessage,
      complainedAt: new Date().toISOString(),
    });
  }

  findByProviderMessageId(providerMessageId: string): EmailDeliveryRecord | null {
    for (const record of this.records.values()) {
      if (record.providerMessageId && record.providerMessageId === providerMessageId) return record;
    }
    return null;
  }

  findByIdempotencyKey(key: string): EmailDeliveryRecord | null {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.records.get(id) ?? null : null;
  }

  get(id: string): EmailDeliveryRecord | null {
    return this.records.get(id) ?? null;
  }

  list(opts: { to?: string; status?: EmailStatus; limit?: number } = {}): EmailDeliveryRecord[] {
    let all = Array.from(this.records.values());
    if (opts.to) all = all.filter((r) => r.to === opts.to);
    if (opts.status) all = all.filter((r) => r.status === opts.status);
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.slice(0, Math.max(1, opts.limit ?? 50));
  }

  /** Deliveries that were accepted but never confirmed — the follow-up list. */
  listProblemDeliveries(): EmailDeliveryRecord[] {
    return this.list({ limit: 500 }).filter((r) => r.status !== 'sent');
  }

  clear(): void {
    this.records.clear();
    this.byIdempotencyKey.clear();
  }
}

export interface EmailDeliveryServiceOptions {
  transport?: EmailTransport;
  store?: MemoryEmailDeliveryStore;
  /** Total attempts (1 = no retry). */
  maxAttempts?: number;
  /** Base backoff between attempts, in ms. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Recovery checkpoints for keyed sends (#289). Defaults to a process-local store. */
  checkpoints?: CheckpointStore;
  /** A `started` checkpoint older than this is treated as a crashed send. */
  checkpointStaleAfterMs?: number;
}

/** Identifies what a key was used for: the fields that make up the delivered email. */
export function emailFingerprint(message: EmailMessage): string {
  return fingerprintOf([message.to, message.subject, message.text ?? null, message.html ?? null, message.replyTo ?? null]);
}

/** Carries a failed result out of the checkpoint so it is recorded as `failed`. */
class DeliveryFailed extends Error {
  constructor(readonly result: EmailDeliveryResult) {
    super(result.message ?? 'Email delivery failed');
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EmailDeliveryService {
  private readonly transport: EmailTransport;
  private readonly store: MemoryEmailDeliveryStore;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly checkpoints: CheckpointStore;
  private readonly checkpointStaleAfterMs?: number;

  constructor(options: EmailDeliveryServiceOptions = {}) {
    this.transport = options.transport ?? disabledTransport;
    this.store = options.store ?? new MemoryEmailDeliveryStore();
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.checkpoints = options.checkpoints ?? new MemoryCheckpointStore();
    this.checkpointStaleAfterMs = options.checkpointStaleAfterMs;
  }

  /**
   * Sends a message and always returns an explicit result. Never throws for a
   * provider failure: the caller always learns whether the mail was accepted.
   */
  async deliver(message: EmailMessage): Promise<EmailDeliveryResult> {
    if (!isValidRecipient(message?.to)) {
      const delivery = this.store.record({
        to: message?.to ?? '',
        subject: message?.subject ?? '',
        status: 'failed',
        category: 'invalid_recipient',
        provider: this.transport.name,
        attempts: 0,
        errorMessage: 'Recipient is not a valid email address',
        metadata: message?.metadata,
      });
      return {
        status: 'failed',
        ok: false,
        delivery,
        category: 'invalid_recipient',
        retryable: false,
        message: 'Recipient is not a valid email address',
      };
    }

    // Never send the same logical email twice on a retry: the checkpoint below
    // replays the first result for the same key and payload, and refuses the
    // key for a different payload. Without a key the send is not deduplicated.
    if (!message.idempotencyKey) return this.send(message);

    try {
      return await runWithCheckpoint(
        this.checkpoints,
        {
          key: `email:${message.idempotencyKey}`,
          effect: 'email.send',
          fingerprint: emailFingerprint(message),
          staleAfterMs: this.checkpointStaleAfterMs,
          now: () => new Date(this.now()),
        },
        async () => {
          const result = await this.send(message);
          if (!result.ok) throw new DeliveryFailed(result);
          return result;
        }
      );
    } catch (error) {
      if (error instanceof DeliveryFailed) return error.result;
      if (error instanceof CheckpointInProgressError) {
        return { status: 'failed', ok: false, category: 'in_progress', retryable: true, message: error.message };
      }
      if (error instanceof CheckpointKeyReusedError) {
        return { status: 'failed', ok: false, category: 'key_reused', retryable: false, message: error.message };
      }
      if (error instanceof CheckpointInDoubtError) {
        return { status: 'failed', ok: false, category: 'in_doubt', retryable: false, message: error.message };
      }
      // The checkpoint store is unreachable: refuse rather than send unrecorded.
      return {
        status: 'failed',
        ok: false,
        category: 'transient',
        retryable: true,
        message: `Delivery checkpoint unavailable: ${(error as Error).message}`,
      };
    }
  }

  /** One logical send: the transport call with bounded retries. Never throws. */
  private async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    let lastError: EmailDeliveryError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await this.transport.send(message);
        const delivery = this.store.record({
          to: message.to,
          subject: message.subject,
          status: 'sent',
          provider: this.transport.name,
          providerMessageId: result.providerMessageId,
          attempts: attempt,
          metadata: message.metadata
            ? { ...message.metadata, idempotencyKey: message.idempotencyKey ?? '' }
            : message.idempotencyKey
              ? { idempotencyKey: message.idempotencyKey }
              : undefined,
        });
        return { status: 'sent', ok: true, delivery, message: 'Accepted by provider' };
      } catch (error) {
        lastError = classifyProviderError(error);
        if (!lastError.retryable || attempt === this.maxAttempts) break;
        await this.sleep(this.retryDelayMs * attempt);
      }
    }

    const error = lastError ?? new EmailDeliveryError('Unknown provider error', 'permanent');
    const delivery = this.store.record({
      to: message.to,
      subject: message.subject,
      status: 'failed',
      category: error.category,
      provider: this.transport.name,
      providerCode: error.providerCode,
      attempts: this.maxAttempts,
      errorMessage: error.message,
      metadata: message.idempotencyKey
        ? { idempotencyKey: message.idempotencyKey }
        : message.metadata,
    });

    return {
      status: 'failed',
      ok: false,
      delivery,
      category: error.category,
      retryable: error.retryable,
      message: error.message,
    };
  }

  /** Ingests a provider bounce notification. */
  recordBounce(providerMessageId: string, reason?: string): EmailDeliveryRecord | null {
    return this.store.markBounced(providerMessageId, reason);
  }

  /** Ingests a provider spam complaint. */
  recordComplaint(providerMessageId: string, reason?: string): EmailDeliveryRecord | null {
    return this.store.markComplained(providerMessageId, reason);
  }

  listDeliveries(opts: { to?: string; status?: EmailStatus; limit?: number } = {}): EmailDeliveryRecord[] {
    return this.store.list(opts);
  }

  listProblems(): EmailDeliveryRecord[] {
    return this.store.listProblemDeliveries();
  }

  getStore(): MemoryEmailDeliveryStore {
    return this.store;
  }
}

/** Used until a transport is configured — fails loudly instead of pretending. */
export const disabledTransport: EmailTransport = {
  name: 'disabled',
  async send() {
    throw new EmailDeliveryError(
      'No email transport is configured (see docs/EMAIL_DELIVERY.md)',
      'config',
      { retryable: false },
    );
  },
};

export interface HttpApiTransportOptions {
  endpoint: string;
  token: string;
  from: string;
  fetchImpl?: typeof fetch;
  providerName?: string;
  /**
   * Strict outbound allow-list (#291). When set, the endpoint is checked when
   * the transport is built and its resolved addresses before every send.
   */
  allowList?: OutboundUrlPolicy & { lookup?: AddressLookup };
}

/** Transactional provider over HTTPS (no extra dependency required). */
export function createHttpApiTransport(options: HttpApiTransportOptions): EmailTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const allowList = options.allowList;
  // Fail at startup, not on the first customer email.
  const endpoint = allowList ? checkOutboundUrl(options.endpoint, allowList) : null;
  return {
    name: options.providerName ?? 'http-api',
    async send(message: EmailMessage) {
      if (endpoint) {
        try {
          await checkPublicDestination(endpoint.hostname, allowList?.lookup);
        } catch (error) {
          const violation = error as AllowListViolation;
          // A DNS outage clears on its own; a private address is a misconfiguration.
          const retryable = violation.code === 'DESTINATION_UNRESOLVABLE';
          throw new EmailDeliveryError(violation.message, retryable ? 'transient' : 'config', {
            retryable,
            providerCode: violation.code,
          });
        }
      }
      const response = await doFetch(options.endpoint, {
        method: 'POST',
        // A redirect would re-send the message body to a host nobody allow-listed.
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          reply_to: message.replyTo,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EmailDeliveryError(
          `Email provider rejected the request (${response.status}): ${body.slice(0, 200)}`,
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status === 429
              ? 'quota'
              : response.status >= 500
                ? 'transient'
                : 'permanent',
          { retryable: response.status === 429 || response.status >= 500, providerCode: String(response.status) },
        );
      }

      const payload = (await response.json().catch(() => ({}))) as { id?: string; messageId?: string };
      return { providerMessageId: payload.id ?? payload.messageId };
    },
  };
}

/** Adapts a nodemailer-compatible client to the transport interface. */
export function createSmtpTransport(
  client: { sendMail: (mail: Record<string, unknown>) => Promise<{ messageId?: string; accepted?: string[]; rejected?: string[] }> },
  providerName = 'smtp'
): EmailTransport {
  return {
    name: providerName,
    async send(message: EmailMessage) {
      const info = await client.sendMail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
      });
      if (info.rejected?.length && !info.accepted?.length) {
        throw new EmailDeliveryError('All recipients were rejected by the SMTP server', 'invalid_recipient', {
          retryable: false,
        });
      }
      return {
        providerMessageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
      };
    },
  };
}

export const emailDeliveryService = new EmailDeliveryService();
