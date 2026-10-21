/**
 * Deterministic fee calculation (#198): zero fee, minimum fee, multi-line fees,
 * rounding, invalid asset precision, determinism and settlement matching.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  FeeCalculationError,
  calculateFee,
  feeScheduleFromEnv,
  formatMinorUnits,
  toMinorUnits,
  toSettlementFeeRecord,
  verifyFeeBreakdown,
  ZERO_FEE_SCHEDULE,
  type FeeSchedule,
} from '../src/domain/fee-calculation';
import { createFeeRouter } from '../src/routes/fee.routes';

const MULTI: FeeSchedule = {
  version: '2026-10',
  lines: [
    { code: 'PLATFORM', label: 'Platform fee', kind: 'PERCENT', basisPoints: 125 },
    { code: 'PROCESSING', label: 'Processing', kind: 'FLAT', amount: '0.2500000' },
  ],
};

function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof FeeCalculationError && e.code === code);
}

describe('fee calculation', () => {
  it('charges nothing under the zero schedule and keeps the full amount', () => {
    const b = calculateFee({ amount: '100', assetCode: 'xlm' }, ZERO_FEE_SCHEDULE);
    assert.equal(b.totalFee, '0.0000000');
    assert.equal(b.netAmount, '100.0000000');
    assert.equal(b.assetCode, 'XLM');
    assert.deepEqual(b.lines, []);
  });

  it('adds a minimum-fee adjustment only when lines fall below the floor', () => {
    const schedule: FeeSchedule = {
      version: 'min',
      lines: [{ code: 'PLATFORM', label: 'Platform', kind: 'PERCENT', basisPoints: 100 }],
      minimumFee: '0.5',
    };
    const small = calculateFee({ amount: '10' }, schedule); // 1% = 0.1 < 0.5
    assert.equal(small.totalFee, '0.5000000');
    assert.equal(small.lines.at(-1)?.code, 'MINIMUM_FEE_ADJUSTMENT');
    assert.equal(small.lines.at(-1)?.amount, '0.4000000');
    const large = calculateFee({ amount: '1000' }, schedule); // 10 > 0.5
    assert.equal(large.totalFee, '10.0000000');
    assert.equal(large.lines.some((l) => l.code === 'MINIMUM_FEE_ADJUSTMENT'), false);
  });

  it('produces a multi-line breakdown whose lines sum to the total', () => {
    const b = calculateFee({ amount: '200' }, MULTI);
    assert.deepEqual(b.lines.map((l) => [l.code, l.amount]), [['PLATFORM', '2.5000000'], ['PROCESSING', '0.2500000']]);
    assert.equal(b.totalFee, '2.7500000');
    assert.equal(b.netAmount, '197.2500000');
    const sum = b.lines.reduce((acc, l) => acc + toMinorUnits(l.amount, 7), 0n);
    assert.equal(formatMinorUnits(sum, 7), b.totalFee);
    assert.match(b.lines[0].explanation, /1\.25% \(125 bp\)/);
  });

  it('rounds per line with the declared mode', () => {
    const mk = (rounding?: 'HALF_UP' | 'FLOOR' | 'CEIL'): FeeSchedule => ({
      version: 'r',
      lines: [{ code: 'P', label: 'P', kind: 'PERCENT', basisPoints: 50, rounding }],
    });
    // 0.5% of 0.0000010 (10 stroops) = 0.05 stroop
    assert.equal(calculateFee({ amount: '0.0000010' }, mk('FLOOR')).totalFee, '0.0000000');
    assert.equal(calculateFee({ amount: '0.0000010' }, mk('CEIL')).totalFee, '0.0000001');
    assert.equal(calculateFee({ amount: '0.0000010' }, mk('HALF_UP')).totalFee, '0.0000000');
    // 0.5% of 0.0000100 (100 stroops) = exactly 0.5 stroop -> half up rounds to 1
    assert.equal(calculateFee({ amount: '0.0000100' }, mk()).totalFee, '0.0000001');
    assert.equal(calculateFee({ amount: '0.0000100' }, mk('FLOOR')).totalFee, '0.0000000');
  });

  it('rejects invalid asset precision and amounts finer than the precision', () => {
    for (const precision of [-1, 8, 1.5, Number.NaN]) {
      throwsCode(() => calculateFee({ amount: '1', precision }), 'INVALID_ASSET_PRECISION');
    }
    throwsCode(() => calculateFee({ amount: '1.00000001' }), 'AMOUNT_PRECISION_EXCEEDED');
    throwsCode(() => calculateFee({ amount: '1.005', precision: 2 }), 'AMOUNT_PRECISION_EXCEEDED');
    // trailing zeros past the precision are not a loss of information
    assert.equal(calculateFee({ amount: '1.500', precision: 2 }).grossAmount, '1.50');
    assert.equal(calculateFee({ amount: '5', precision: 0 }).grossAmount, '5');
  });

  it('rejects bad amounts, bad schedules and fees larger than the amount', () => {
    for (const amount of ['', '-1', 'abc', '1e3', '0', 0, Number.NaN, '1,5']) {
      throwsCode(() => calculateFee({ amount: amount as string }), 'INVALID_AMOUNT');
    }
    throwsCode(() => calculateFee({ amount: '10' }, { version: 'x', lines: [{ code: 'bad', label: 'x', kind: 'FLAT', amount: '1' }] }), 'INVALID_FEE_SCHEDULE');
    throwsCode(() => calculateFee({ amount: '10' }, { version: 'x', lines: [{ code: 'P', label: 'x', kind: 'PERCENT', basisPoints: 10_001 }] }), 'INVALID_FEE_SCHEDULE');
    throwsCode(() => calculateFee({ amount: '10' }, { version: 'x', lines: [{ code: 'F', label: 'x', kind: 'FLAT', amount: '1' }, { code: 'F', label: 'y', kind: 'FLAT', amount: '1' }] }), 'INVALID_FEE_SCHEDULE');
    throwsCode(() => calculateFee({ amount: '1' }, { version: 'x', lines: [{ code: 'F', label: 'x', kind: 'FLAT', amount: '2' }] }), 'FEE_EXCEEDS_AMOUNT');
  });

  it('is deterministic for identical inputs and sensitive to any change', () => {
    const a = calculateFee({ amount: '123.4567891', assetCode: 'USDC' }, MULTI);
    const b = calculateFee({ amount: 123.4567891, assetCode: 'usdc' }, MULTI);
    assert.deepEqual(a, b);
    assert.notEqual(a.fingerprint, calculateFee({ amount: '123.4567892', assetCode: 'USDC' }, MULTI).fingerprint);
    assert.notEqual(a.fingerprint, calculateFee({ amount: '123.4567891', assetCode: 'USDC' }, { ...MULTI, version: '2026-11' }).fingerprint);
  });

  it('matches stored settlement records and flags drift', () => {
    const b = calculateFee({ amount: '200', assetCode: 'USDC' }, MULTI);
    const record = toSettlementFeeRecord(b);
    assert.deepEqual(verifyFeeBreakdown(b, record), { matches: true, mismatches: [] });
    // numerically equal values stored without padding still match
    assert.equal(verifyFeeBreakdown(b, { ...record, totalFee: '2.75', netAmount: '197.25', grossAmount: '200' }).matches, true);
    const drift = verifyFeeBreakdown(b, { ...record, totalFee: '2.76', assetCode: 'XLM' });
    assert.deepEqual(drift.mismatches, ['assetCode', 'totalFee']);
    assert.equal(verifyFeeBreakdown(b, { ...record, fingerprint: 'deadbeef' }).mismatches.includes('fingerprint'), true);
  });

  it('loads the schedule from FEE_SCHEDULE_JSON', () => {
    assert.equal(feeScheduleFromEnv({}), ZERO_FEE_SCHEDULE);
    assert.equal(feeScheduleFromEnv({ FEE_SCHEDULE_JSON: JSON.stringify(MULTI) }).version, '2026-10');
    throwsCode(() => feeScheduleFromEnv({ FEE_SCHEDULE_JSON: '{nope' }), 'INVALID_FEE_SCHEDULE');
    throwsCode(() => feeScheduleFromEnv({ FEE_SCHEDULE_JSON: '{"version":"x","lines":"no"}' }), 'INVALID_FEE_SCHEDULE');
  });
});

describe('POST /fees/quote', () => {
  async function post(body: unknown, schedule = MULTI) {
    const app = express();
    app.use(express.json());
    app.use('/api', createFeeRouter({ schedule }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/fees/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    } finally {
      server.close();
    }
  }

  it('returns the same breakdown the calculator produces', async () => {
    const { status, json } = await post({ amount: '200', assetCode: 'USDC' });
    assert.equal(status, 200);
    assert.deepEqual(json.data, calculateFee({ amount: '200', assetCode: 'USDC' }, MULTI));
  });

  it('answers invalid input with a stable code', async () => {
    const { status, json } = await post({ amount: '1.00000001' });
    assert.equal(status, 400);
    assert.equal(json.code, 'AMOUNT_PRECISION_EXCEEDED');
    assert.equal((await post({})).json.code, 'INVALID_AMOUNT');
  });
});
