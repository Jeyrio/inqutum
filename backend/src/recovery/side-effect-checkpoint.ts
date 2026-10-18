/**
 * Recovery checkpoints around external side effects (#289).
 *
 * A side effect that leaves the process (an email handed to a provider) cannot
 * be rolled back, and a crash between "the provider accepted it" and "we wrote
 * that down" leaves the outcome unknown. A checkpoint records intent before the
 * call and the outcome after it, keyed by a caller-supplied idempotency key:
 *
 *   (none) ──claim──▶ started ──ok──▶ succeeded   replay returns the stored result
 *                        │ └──error─▶ failed      the next claim may run it again
 *                        └─stale────▶ in_doubt    outcome unknown: never re-run blindly
 *
 * A `started` checkpoint older than `staleAfterMs` belongs to a run that died.
 * If the caller can ask the provider what happened (`reconcile`), the answer
 * settles it; otherwise it becomes `in_doubt` and stays there until an operator
 * resolves it (see docs/RECOVERY_CHECKPOINTS.md). Every settle is fenced by the
 * attempt number, so a run that lost its claim cannot overwrite a newer one.
 *
 * A key belongs to one request payload, identified by a fingerprint. Reusing it
 * for a different payload is refused rather than answered with the first
 * payload's result (IETF draft-ietf-httpapi-idempotency-key-header s2.7: 422).
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** SHA-256 of a JSON-serialisable payload. Pass arrays so field order is fixed. O(n). */
export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export type CheckpointState = 'started' | 'succeeded' | 'failed' | 'in_doubt';

export interface Checkpoint {
  key: string;
  effect: string;
  /** Digest of the request payload the key was first used with. */
  fingerprint: string | null;
  state: CheckpointState;
  /** Incremented on every claim; doubles as the fencing token. */
  attempt: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ClaimOutcome =
  | { claimed: true; checkpoint: Checkpoint; /** Took over a stale `started` run. */ recovered: boolean }
  | { claimed: false; checkpoint: Checkpoint };

export interface CheckpointStore {
  /**
   * Atomically creates a `started` checkpoint, or takes over a `failed` one or
   * a `started` one last touched before `staleBefore` when the fingerprint
   * matches. Otherwise returns the existing checkpoint unclaimed.
   */
  claim(key: string, effect: string, fingerprint: string | null, now: Date, staleBefore: Date): Promise<ClaimOutcome>;
  /** Moves a `started` checkpoint at `attempt` to a terminal state; null when fenced out. */
  settle(
    key: string,
    attempt: number,
    state: Exclude<CheckpointState, 'started'>,
    outcome: { result?: unknown; error?: string },
    now: Date
  ): Promise<Checkpoint | null>;
  get(key: string): Promise<Checkpoint | null>;
}

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export class CheckpointInProgressError extends Error {
  constructor(readonly checkpoint: Checkpoint) {
    super(`Side effect ${checkpoint.key} is already in progress; retry later`);
    this.name = 'CheckpointInProgressError';
  }
}

export class CheckpointInDoubtError extends Error {
  constructor(readonly checkpoint: Checkpoint) {
    super(
      `Side effect ${checkpoint.key} may or may not have happened (a previous run stopped mid-call). ` +
        'An operator must confirm the outcome before it can run again.'
    );
    this.name = 'CheckpointInDoubtError';
  }
}

export class CheckpointKeyReusedError extends Error {
  constructor(readonly checkpoint: Checkpoint) {
    super(`Idempotency key ${checkpoint.key} was already used for a different request`);
    this.name = 'CheckpointKeyReusedError';
  }
}

export interface SideEffectOptions<T> {
  key: string;
  effect: string;
  /** Digest of the request payload; a mismatch on an existing key is refused. */
  fingerprint?: string;
  staleAfterMs?: number;
  now?: () => Date;
  /**
   * Asks the external system whether a crashed run's call landed. Return
   * `{ done: true, result }` if it did, `{ done: false }` if it provably did not.
   * Throw if it cannot tell; the checkpoint is then left for a later retry.
   */
  reconcile?: () => Promise<{ done: true; result: T } | { done: false }>;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Runs `perform` at most once per key across retries and restarts.
 * Two store round-trips per call: O(1) time and space beyond `perform` itself.
 */
export async function runWithCheckpoint<T>(
  store: CheckpointStore,
  options: SideEffectOptions<T>,
  perform: () => Promise<T>
): Promise<T> {
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? ((message, meta) => console.error(`[checkpoint] ${message}`, meta));
  const now = clock();
  const staleBefore = new Date(now.getTime() - (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));

  const fingerprint = options.fingerprint ?? null;
  const outcome = await store.claim(options.key, options.effect, fingerprint, now, staleBefore);
  if (!outcome.claimed) {
    const { checkpoint } = outcome;
    if (checkpoint.fingerprint !== fingerprint) throw new CheckpointKeyReusedError(checkpoint);
    if (checkpoint.state === 'succeeded') return checkpoint.result as T;
    if (checkpoint.state === 'in_doubt') throw new CheckpointInDoubtError(checkpoint);
    throw new CheckpointInProgressError(checkpoint);
  }

  const { attempt } = outcome.checkpoint;
  if (outcome.recovered) {
    if (!options.reconcile) {
      const doubtful = await store.settle(
        options.key,
        attempt,
        'in_doubt',
        { error: 'previous run stopped before recording its outcome' },
        clock()
      );
      throw new CheckpointInDoubtError(doubtful ?? outcome.checkpoint);
    }
    const found = await options.reconcile();
    if (found.done) {
      await store.settle(options.key, attempt, 'succeeded', { result: found.result }, clock());
      return found.result;
    }
  }

  let result: T;
  try {
    result = await perform();
  } catch (error) {
    await store
      .settle(options.key, attempt, 'failed', { error: error instanceof Error ? error.message : String(error) }, clock())
      .catch((settleError) => log('could not record failure', { key: options.key, error: String(settleError) }));
    throw error;
  }

  // The effect has happened. If recording that fails, the checkpoint stays
  // `started`, goes stale and surfaces as in_doubt — never as a silent resend.
  await store
    .settle(options.key, attempt, 'succeeded', { result }, clock())
    .catch((settleError) => log('could not record success', { key: options.key, error: String(settleError) }));
  return result;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Process-local store: survives retries, not restarts. For the MVP server and tests. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();

  async claim(key: string, effect: string, fingerprint: string | null, now: Date, staleBefore: Date): Promise<ClaimOutcome> {
    const existing = this.checkpoints.get(key);
    const stale = existing?.state === 'started' && Date.parse(existing.updatedAt) < staleBefore.getTime();
    if (existing && ((existing.state !== 'failed' && !stale) || existing.fingerprint !== fingerprint)) {
      return { claimed: false, checkpoint: clone(existing) };
    }
    const checkpoint: Checkpoint = {
      key,
      effect,
      fingerprint,
      state: 'started',
      attempt: (existing?.attempt ?? 0) + 1,
      result: null,
      error: null,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.checkpoints.set(key, checkpoint);
    return { claimed: true, checkpoint: clone(checkpoint), recovered: stale };
  }

  async settle(
    key: string,
    attempt: number,
    state: Exclude<CheckpointState, 'started'>,
    outcome: { result?: unknown; error?: string },
    now: Date
  ): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.get(key);
    if (!checkpoint || checkpoint.attempt !== attempt || checkpoint.state !== 'started') return null;
    checkpoint.state = state;
    checkpoint.result = outcome.result === undefined ? null : clone(outcome.result);
    checkpoint.error = outcome.error ?? null;
    checkpoint.updatedAt = now.toISOString();
    return clone(checkpoint);
  }

  async get(key: string): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.get(key);
    return checkpoint ? clone(checkpoint) : null;
  }
}

const COLUMNS = 'key, effect, fingerprint, state, attempt, result, error, created_at, updated_at';

function rowToCheckpoint(row: any): Checkpoint {
  return {
    key: row.key,
    effect: row.effect,
    fingerprint: row.fingerprint ?? null,
    state: row.state,
    attempt: row.attempt,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Durable store backed by `side_effect_checkpoints` (db/schema.sql). */
export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async claim(key: string, effect: string, fingerprint: string | null, now: Date, staleBefore: Date): Promise<ClaimOutcome> {
    // `prior` reads the pre-statement snapshot, so it reports the state that
    // was taken over. The upsert's WHERE re-checks the latest row version under
    // its lock, so two concurrent claims can never both succeed.
    const claimed = await this.pool.query(
      `WITH prior AS (SELECT state FROM side_effect_checkpoints WHERE key = $1)
       INSERT INTO side_effect_checkpoints (key, effect, fingerprint, state, attempt, created_at, updated_at)
       VALUES ($1, $2, $5, 'started', 1, $3, $3)
       ON CONFLICT (key) DO UPDATE
         SET state = 'started', attempt = side_effect_checkpoints.attempt + 1,
             result = NULL, error = NULL, updated_at = $3
         WHERE side_effect_checkpoints.fingerprint IS NOT DISTINCT FROM $5
           AND (side_effect_checkpoints.state = 'failed'
             OR (side_effect_checkpoints.state = 'started' AND side_effect_checkpoints.updated_at < $4))
       RETURNING ${COLUMNS}, (SELECT state FROM prior) AS prior_state`,
      [key, effect, now, staleBefore, fingerprint]
    );
    const row = claimed.rows[0];
    if (row) return { claimed: true, checkpoint: rowToCheckpoint(row), recovered: row.prior_state === 'started' };

    const existing = await this.pool.query(`SELECT ${COLUMNS} FROM side_effect_checkpoints WHERE key = $1`, [key]);
    return { claimed: false, checkpoint: rowToCheckpoint(existing.rows[0]) };
  }

  async settle(
    key: string,
    attempt: number,
    state: Exclude<CheckpointState, 'started'>,
    outcome: { result?: unknown; error?: string },
    now: Date
  ): Promise<Checkpoint | null> {
    const res = await this.pool.query(
      `UPDATE side_effect_checkpoints SET state = $3, result = $4, error = $5, updated_at = $6
       WHERE key = $1 AND attempt = $2 AND state = 'started'
       RETURNING ${COLUMNS}`,
      [key, attempt, state, JSON.stringify(outcome.result ?? null), outcome.error ?? null, now]
    );
    return res.rows[0] ? rowToCheckpoint(res.rows[0]) : null;
  }

  async get(key: string): Promise<Checkpoint | null> {
    const res = await this.pool.query(`SELECT ${COLUMNS} FROM side_effect_checkpoints WHERE key = $1`, [key]);
    return res.rows[0] ? rowToCheckpoint(res.rows[0]) : null;
  }
}
