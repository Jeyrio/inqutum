/**
 * Deterministic fee calculation with explainable breakdowns (#198).
 *
 * One module owns fee math. It is pure: the same (schedule, amount, asset) always
 * yields the same breakdown, byte for byte, with no clock, randomness or float
 * arithmetic. All money is held as bigint minor units at the asset's precision
 * and only formatted to decimal strings at the edges.
 *
 *   gross amount = what the payer sends
 *   fee lines    = FLAT and PERCENT lines from the schedule, each rounded on its own
 *                  (so the printed lines always add up to the printed total), plus an
 *                  optional MINIMUM_FEE_ADJUSTMENT that tops the total up to the floor
 *   net amount   = gross - total fee
 *
 * `fingerprint` is a SHA-256 over the canonical breakdown, so a stored settlement
 * record can be proven to match a recomputation (`verifyFeeBreakdown`).
 *
 * See docs/FEE_CALCULATION.md.
 */
import { createHash } from 'crypto';
import { canonicalize } from '../security/canonical-serialization';

export const MAX_ASSET_PRECISION = 7; // Stellar stroops
export const BASIS_POINTS_DENOMINATOR = 10_000n;
export const FEE_BREAKDOWN_VERSION = 1;

export type RoundingMode = 'HALF_UP' | 'FLOOR' | 'CEIL';
export const ROUNDING_MODES: readonly RoundingMode[] = ['HALF_UP', 'FLOOR', 'CEIL'];

export type FeeErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_ASSET_PRECISION'
  | 'AMOUNT_PRECISION_EXCEEDED'
  | 'INVALID_FEE_SCHEDULE'
  | 'FEE_EXCEEDS_AMOUNT';

export class FeeCalculationError extends Error {
  constructor(public readonly code: FeeErrorCode, message: string) {
    super(message);
    this.name = 'FeeCalculationError';
  }
}

export interface FlatFeeLineSpec {
  code: string;
  label: string;
  kind: 'FLAT';
  /** Decimal string in the asset, e.g. "0.5000000". */
  amount: string;
}

export interface PercentFeeLineSpec {
  code: string;
  label: string;
  kind: 'PERCENT';
  /** 1 bp = 0.01%. Integer 0..10000. */
  basisPoints: number;
  rounding?: RoundingMode;
}

export type FeeLineSpec = FlatFeeLineSpec | PercentFeeLineSpec;

export interface FeeSchedule {
  /** Opaque label recorded on every breakdown, e.g. "2026-10". */
  version: string;
  lines: FeeLineSpec[];
  /** Floor for the total fee, as a decimal string. Applied only when lines sum below it. */
  minimumFee?: string;
}

/** Platform default: no platform fee. Operators opt in through FEE_SCHEDULE_JSON. */
export const ZERO_FEE_SCHEDULE: FeeSchedule = Object.freeze({ version: 'zero', lines: [] }) as FeeSchedule;

export interface FeeInput {
  amount: string | number;
  assetCode?: string;
  /** Decimal places the asset settles at. Defaults to 7. */
  precision?: number;
}

export interface FeeBreakdownLine {
  code: string;
  label: string;
  kind: 'FLAT' | 'PERCENT' | 'MINIMUM_FEE_ADJUSTMENT';
  /** Fee for this line, decimal string at asset precision. */
  amount: string;
  /** Human-readable derivation, safe to show to payers. */
  explanation: string;
}

export interface FeeBreakdown {
  breakdownVersion: number;
  scheduleVersion: string;
  assetCode: string;
  precision: number;
  grossAmount: string;
  lines: FeeBreakdownLine[];
  totalFee: string;
  netAmount: string;
  fingerprint: string;
}

/** The subset of a breakdown persisted with a settlement record. */
export interface SettlementFeeRecord {
  assetCode: string;
  grossAmount: string;
  totalFee: string;
  netAmount: string;
  scheduleVersion?: string;
  fingerprint?: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;

export function assertPrecision(precision: unknown): number {
  if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > MAX_ASSET_PRECISION) {
    throw new FeeCalculationError(
      'INVALID_ASSET_PRECISION',
      `Asset precision must be an integer from 0 to ${MAX_ASSET_PRECISION}`
    );
  }
  return precision;
}

/** Parses a non-negative decimal into minor units; rejects more fractional digits than `precision`. */
export function toMinorUnits(value: unknown, precision: number, field = 'amount'): bigint {
  const text = typeof value === 'number' ? numberToPlainString(value) : typeof value === 'string' ? value.trim() : '';
  if (!DECIMAL.test(text)) {
    throw new FeeCalculationError('INVALID_AMOUNT', `${field} must be a non-negative decimal number`);
  }
  const [whole, frac = ''] = text.split('.');
  if (frac.length > precision) {
    // Trailing zeros beyond precision are harmless ("1.50" at precision 1); anything else would round silently.
    if (/[1-9]/.test(frac.slice(precision))) {
      throw new FeeCalculationError(
        'AMOUNT_PRECISION_EXCEEDED',
        `${field} has more than ${precision} decimal place${precision === 1 ? '' : 's'}`
      );
    }
  }
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac.slice(0, precision).padEnd(precision, '0') || '0');
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const text = String(n);
  // Exponent notation (1e-7) is not a plain decimal; expand it without float math.
  if (!/e/i.test(text)) return text;
  return n.toFixed(MAX_ASSET_PRECISION).replace(/\.?0+$/, '');
}

export function formatMinorUnits(units: bigint, precision: number): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  if (precision === 0) return `${sign}${abs}`;
  const scale = 10n ** BigInt(precision);
  return `${sign}${abs / scale}.${(abs % scale).toString().padStart(precision, '0')}`;
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (mode) {
    case 'FLOOR':
      return quotient;
    case 'CEIL':
      return quotient + 1n;
    case 'HALF_UP':
      return remainder * 2n >= denominator ? quotient + 1n : quotient;
  }
}

function validateSchedule(schedule: FeeSchedule): void {
  const bad = (msg: string) => new FeeCalculationError('INVALID_FEE_SCHEDULE', msg);
  if (!schedule || typeof schedule.version !== 'string' || !schedule.version.trim()) throw bad('Fee schedule needs a version');
  if (!Array.isArray(schedule.lines)) throw bad('Fee schedule lines must be an array');
  const seen = new Set<string>();
  for (const line of schedule.lines) {
    if (!line || typeof line.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,40}$/.test(line.code)) {
      throw bad('Fee line code must be UPPER_SNAKE_CASE');
    }
    if (seen.has(line.code)) throw bad(`Duplicate fee line code ${line.code}`);
    seen.add(line.code);
    if (typeof line.label !== 'string' || !line.label.trim()) throw bad(`Fee line ${line.code} needs a label`);
    if (line.kind === 'PERCENT') {
      if (!Number.isInteger(line.basisPoints) || line.basisPoints < 0 || line.basisPoints > 10_000) {
        throw bad(`Fee line ${line.code} basisPoints must be an integer from 0 to 10000`);
      }
      if (line.rounding !== undefined && !ROUNDING_MODES.includes(line.rounding)) {
        throw bad(`Fee line ${line.code} has unknown rounding mode`);
      }
    } else if (line.kind !== 'FLAT') {
      throw bad(`Fee line ${(line as { code: string }).code} has unknown kind`);
    }
  }
}

export function calculateFee(input: FeeInput, schedule: FeeSchedule = ZERO_FEE_SCHEDULE): FeeBreakdown {
  const precision = assertPrecision(input.precision ?? MAX_ASSET_PRECISION);
  validateSchedule(schedule);
  const assetCode = (input.assetCode ?? 'XLM').trim().toUpperCase() || 'XLM';
  const gross = toMinorUnits(input.amount, precision);
  if (gross <= 0n) throw new FeeCalculationError('INVALID_AMOUNT', 'amount must be greater than zero');

  const fmt = (u: bigint) => formatMinorUnits(u, precision);
  const lines: FeeBreakdownLine[] = [];
  let total = 0n;

  for (const spec of schedule.lines) {
    if (spec.kind === 'FLAT') {
      const fee = toMinorUnits(spec.amount, precision, `fee line ${spec.code} amount`);
      lines.push({ code: spec.code, label: spec.label, kind: 'FLAT', amount: fmt(fee), explanation: `Flat fee of ${fmt(fee)} ${assetCode}` });
      total += fee;
    } else {
      const mode = spec.rounding ?? 'HALF_UP';
      const fee = divideRounded(gross * BigInt(spec.basisPoints), BASIS_POINTS_DENOMINATOR, mode);
      const pct = (spec.basisPoints / 100).toFixed(2);
      lines.push({
        code: spec.code,
        label: spec.label,
        kind: 'PERCENT',
        amount: fmt(fee),
        explanation: `${pct}% (${spec.basisPoints} bp) of ${fmt(gross)} ${assetCode}, rounded ${mode.toLowerCase().replace('_', ' ')} to ${precision} decimals`,
      });
      total += fee;
    }
  }

  if (schedule.minimumFee !== undefined) {
    const floor = toMinorUnits(schedule.minimumFee, precision, 'minimumFee');
    if (total < floor) {
      const top = floor - total;
      lines.push({
        code: 'MINIMUM_FEE_ADJUSTMENT',
        label: 'Minimum fee adjustment',
        kind: 'MINIMUM_FEE_ADJUSTMENT',
        amount: fmt(top),
        explanation: `Fees of ${fmt(total)} ${assetCode} are below the ${fmt(floor)} ${assetCode} minimum; ${fmt(top)} added`,
      });
      total = floor;
    }
  }

  if (total > gross) {
    throw new FeeCalculationError('FEE_EXCEEDS_AMOUNT', `Total fee ${fmt(total)} exceeds the amount ${fmt(gross)}`);
  }

  const body = {
    breakdownVersion: FEE_BREAKDOWN_VERSION,
    scheduleVersion: schedule.version,
    assetCode,
    precision,
    grossAmount: fmt(gross),
    lines,
    totalFee: fmt(total),
    netAmount: fmt(gross - total),
  };
  return { ...body, fingerprint: createHash('sha256').update(canonicalize(body)).digest('hex') };
}

export function toSettlementFeeRecord(breakdown: FeeBreakdown): SettlementFeeRecord {
  return {
    assetCode: breakdown.assetCode,
    grossAmount: breakdown.grossAmount,
    totalFee: breakdown.totalFee,
    netAmount: breakdown.netAmount,
    scheduleVersion: breakdown.scheduleVersion,
    fingerprint: breakdown.fingerprint,
  };
}

export interface FeeVerification {
  matches: boolean;
  /** Field names that differ; empty when matches. */
  mismatches: string[];
}

/** Compares a breakdown to a stored settlement record. Amounts compare as minor units, not strings. */
export function verifyFeeBreakdown(breakdown: FeeBreakdown, record: SettlementFeeRecord): FeeVerification {
  const mismatches: string[] = [];
  if (breakdown.assetCode !== String(record.assetCode ?? '').toUpperCase()) mismatches.push('assetCode');
  for (const field of ['grossAmount', 'totalFee', 'netAmount'] as const) {
    let same = false;
    try {
      same = toMinorUnits(breakdown[field], breakdown.precision) === toMinorUnits(record[field], breakdown.precision);
    } catch {
      same = false;
    }
    if (!same) mismatches.push(field);
  }
  if (record.scheduleVersion !== undefined && record.scheduleVersion !== breakdown.scheduleVersion) mismatches.push('scheduleVersion');
  if (record.fingerprint !== undefined && record.fingerprint !== breakdown.fingerprint) mismatches.push('fingerprint');
  return { matches: mismatches.length === 0, mismatches };
}

/** Reads FEE_SCHEDULE_JSON; falls back to the zero schedule when unset. Throws on a malformed schedule. */
export function feeScheduleFromEnv(env: NodeJS.ProcessEnv = process.env): FeeSchedule {
  const raw = env.FEE_SCHEDULE_JSON;
  if (!raw || !raw.trim()) return ZERO_FEE_SCHEDULE;
  let parsed: FeeSchedule;
  try {
    parsed = JSON.parse(raw) as FeeSchedule;
  } catch {
    throw new FeeCalculationError('INVALID_FEE_SCHEDULE', 'FEE_SCHEDULE_JSON is not valid JSON');
  }
  validateSchedule(parsed);
  return parsed;
}
