export type OperationStatus =
  | 'QUEUED'
  | 'IN_FLIGHT'
  | 'COMMITTED'
  | 'CONFLICT'
  | 'DISCARDED'
  | 'FAILED';

export type ConflictResolutionAction =
  | 'RETRY_WITH_LATEST'
  | 'DISCARD'
  | 'FORCE_APPLY';

export interface ConflictDetails {
  hasConflict: boolean;
  reason?: 'ENTITY_NOT_FOUND' | 'VERSION_MISMATCH' | 'TERMINAL_STATUS_CONFLICT';
  message?: string;
  expected?: { version?: number; status?: string };
  actual?: { version?: number; status?: string } | null;
}

export interface QueuedOperation<T = unknown> {
  id: string;
  type: string;
  entityId: string;
  payload: T;
  baseVersion: number;
  baseStatus: string;
  status: OperationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  conflict: ConflictDetails | null;
  error: string | null;
  result?: unknown;
}

export interface OperationQueueOptions {
  storage?: Storage | null;
  broadcastChannel?: BroadcastChannel | null;
  now?: () => Date;
  maxRetries?: number;
  tabId?: string;
}

export declare class OperationQueue {
  constructor(options?: OperationQueueOptions);
  enqueue<T = unknown>(op: {
    id?: string;
    type: string;
    entityId: string;
    payload?: T;
    baseVersion?: number;
    baseStatus?: string;
  }): QueuedOperation<T>;

  evaluateConflict(
    operation: QueuedOperation,
    currentState?: { version?: number; status?: string } | null
  ): ConflictDetails;

  processOperation<T = unknown>(
    operationId: string,
    currentStateFetcher: (entityId: string) => Promise<{ version?: number; status?: string } | null>,
    executor: (op: QueuedOperation<T>, currentState: any) => Promise<unknown>
  ): Promise<QueuedOperation<T>>;

  resolveConflict(
    operationId: string,
    action: ConflictResolutionAction,
    latestState?: { version?: number; status?: string } | null
  ): QueuedOperation;

  getOperation(id: string): QueuedOperation | null;
  getPendingOperations(): QueuedOperation[];
  getConflictedOperations(): QueuedOperation[];
  getAllOperations(): QueuedOperation[];
  clearCompleted(): number;
  subscribe(listener: (event: string, data: any) => void): () => boolean;
}

export declare const STORAGE_KEY: string;
export declare const CHANNEL_NAME: string;
