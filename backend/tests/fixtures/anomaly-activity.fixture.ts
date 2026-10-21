/**
 * Deterministic activity fixtures for the anomaly report (#195). Everything is
 * derived from a fixed start time and counters, so the same call always yields
 * the same records.
 */
import type { ActivityRecord } from '../../src/ops/anomaly-report';

export const T0 = Date.parse('2026-10-20T00:00:00.000Z');
export const HOUR = 3_600_000;

let counter = 0;
export const resetFixtureIds = () => {
  counter = 0;
};

export function rec(
  offsetMs: number,
  actor: string,
  resource: string,
  action = 'INVOICE_CREATED',
  outcome: 'success' | 'failure' = 'success'
): ActivityRecord {
  counter++;
  return { id: `evt-${String(counter).padStart(5, '0')}`, timestamp: new Date(T0 + offsetMs).toISOString(), actor, resource, action, outcome };
}

/** `perHour` events per hour for `hours` hours, spread over `actors`, evenly inside each hour. */
export function steadyTraffic(resource: string, hours: number, perHour: number, actors: string[] = ['seller-a', 'seller-b', 'seller-c']): ActivityRecord[] {
  const out: ActivityRecord[] = [];
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < perHour; i++) {
      out.push(rec(h * HOUR + i * Math.floor(HOUR / perHour), actors[(h + i) % actors.length], resource, i % 2 ? 'PAYMENT_VERIFIED' : 'INVOICE_CREATED'));
    }
  }
  return out;
}

/** 24 quiet hours of normal traffic. */
export const normalBaseline = (): ActivityRecord[] => steadyTraffic('system:invoices', 24, 3);

/** Baseline plus a 60-event hour at hour 12, from many actors (a real surge rather than one noisy client). */
export function volumeSpike(): ActivityRecord[] {
  const spike: ActivityRecord[] = [];
  for (let i = 0; i < 60; i++) spike.push(rec(12 * HOUR + 1_000 + i * 50_000, `seller-${i % 12}`, 'system:invoices', 'INVOICE_CREATED'));
  return [...normalBaseline(), ...spike];
}

/** 7 failed verifications in a row by one actor on one invoice, then nothing. */
export function repeatedFailure(): ActivityRecord[] {
  const rows = [...normalBaseline()];
  for (let i = 0; i < 7; i++) rows.push(rec(5 * HOUR + i * 120_000, 'client-x', 'invoice:inv-42', 'PAYMENT_VERIFY_REJECTED', 'failure'));
  return rows;
}

/** One actor sweeping through 14 invoices in six minutes, 9 requests per second on the first. */
export function suspiciousActor(): ActivityRecord[] {
  const rows = [...normalBaseline()];
  for (let i = 0; i < 14; i++) rows.push(rec(8 * HOUR + i * 25_000, 'scraper-1', `invoice:inv-${100 + i}`, 'INVOICE_READ'));
  for (let i = 0; i < 9; i++) rows.push(rec(9 * HOUR + i * 500, 'scraper-1', 'invoice:inv-100', 'INVOICE_READ'));
  return rows;
}

/** A busy but legitimate worker: hundreds of events from a known automation actor. */
export function noisyWorker(): ActivityRecord[] {
  const rows = [...normalBaseline()];
  for (let i = 0; i < 120; i++) rows.push(rec(3 * HOUR + i * 1_000, 'system', 'system:invoices', 'INVOICE_EXPIRED'));
  return rows;
}
