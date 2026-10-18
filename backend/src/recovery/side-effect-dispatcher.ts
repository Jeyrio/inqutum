import {
  fingerprintOf,
  runWithCheckpoint,
  type CheckpointStore,
  type SideEffectOptions,
} from './side-effect-checkpoint';

export interface DispatchRequest<T> {
  key: string;
  effect: string;
  payload: unknown;
  staleAfterMs?: number;
  reconcile?: SideEffectOptions<T>['reconcile'];
}

/**
 * Idempotent side-effect boundary for notifications, exports, and payments.
 * The payload fingerprint prevents accidental key reuse, while the checkpoint
 * store makes retries and dead-letter recovery observable across restarts.
 */
export class SideEffectDispatcher {
  constructor(private readonly checkpoints: CheckpointStore) {}

  dispatch<T>(request: DispatchRequest<T>, perform: () => Promise<T>): Promise<T> {
    return runWithCheckpoint(
      this.checkpoints,
      {
        key: request.key,
        effect: request.effect,
        fingerprint: fingerprintOf(request.payload),
        staleAfterMs: request.staleAfterMs,
        reconcile: request.reconcile,
      },
      perform,
    );
  }
}
