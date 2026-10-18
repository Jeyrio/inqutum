import type { Job, JobFilter, JobStore } from './job-types';

export interface OperatorPrincipal {
  id: string;
  role: 'operator' | 'admin';
}

export class OperatorAuthorizationError extends Error {
  readonly code = 'OPERATOR_AUTH_REQUIRED';

  constructor() {
    super('An operator or admin principal is required for dead-letter operations');
    this.name = 'OperatorAuthorizationError';
  }
}

function authorize(principal: OperatorPrincipal): void {
  if (!principal?.id?.trim() || !['operator', 'admin'].includes(principal.role)) {
    throw new OperatorAuthorizationError();
  }
}

/** Operator-facing dead-letter tooling shared by HTTP handlers and scripts. */
export class DeadLetterOperator {
  constructor(private readonly store: JobStore) {}

  async inspect(principal: OperatorPrincipal, filter: Omit<JobFilter, 'status'> = {}): Promise<{ jobs: Job[]; total: number }> {
    authorize(principal);
    return this.store.list({ ...filter, status: 'dead' });
  }

  async retry(principal: OperatorPrincipal, jobId: string, now = new Date()): Promise<Job> {
    authorize(principal);
    const job = await this.store.requeueDead(jobId, now);
    if (!job) throw new Error(`Job ${jobId} is not dead-lettered or does not exist`);
    return job;
  }
}
