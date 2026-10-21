/**
 * Fee quotes before submission (#198). Mount under `/api`.
 *
 *   POST /fees/quote   { amount, assetCode? }  ->  FeeBreakdown
 *
 * Read-only and side-effect free: the quote is computed by the same module that
 * produces the stored settlement breakdown, so what the user sees is what is
 * recorded.
 */
import { Router, type Request, type Response } from 'express';
import {
  FeeCalculationError,
  calculateFee,
  feeScheduleFromEnv,
  type FeeSchedule,
} from '../domain/fee-calculation';
import { sendFailure, sendSuccess } from '../types/api';

export interface FeeRouterOptions {
  /** Overridable for tests; defaults to FEE_SCHEDULE_JSON (zero fees when unset). */
  schedule?: FeeSchedule;
}

export function createFeeRouter(options: FeeRouterOptions = {}): Router {
  const router = Router();

  router.post('/fees/quote', (req: Request, res: Response) => {
    try {
      const schedule = options.schedule ?? feeScheduleFromEnv();
      const body = (req.body ?? {}) as { amount?: unknown; assetCode?: unknown };
      const breakdown = calculateFee(
        {
          amount: body.amount as string | number,
          assetCode: typeof body.assetCode === 'string' ? body.assetCode : undefined,
        },
        schedule
      );
      sendSuccess(res, 200, breakdown);
    } catch (err) {
      if (err instanceof FeeCalculationError) {
        return sendFailure(res, err.code === 'INVALID_FEE_SCHEDULE' ? 500 : 400, err.message, { code: err.code });
      }
      throw err;
    }
  });

  return router;
}
