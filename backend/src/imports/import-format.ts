/**
 * Import format parsing (#53).
 *
 * The importer accepts two encodings of the same logical record:
 *
 *   CSV    — RFC 4180, header row required. Primary format: reviewable in a
 *            spreadsheet and diffable in a pull request.
 *   NDJSON — one JSON object per line. Convenient when another tool already
 *            emits JSON and re-serialising through a spreadsheet is lossy.
 *
 * Parsing is deliberately separate from validation. This module only turns
 * bytes into rows plus the source position of each row, so every error it can
 * report ("row 14: unterminated quoted field") points at a line the operator
 * can open. Deciding whether a row is *acceptable* is the pipeline's job.
 */

export type ImportEncoding = 'csv' | 'ndjson';

export interface ImportColumnSpec {
  /** Header name, as written in the file. */
  column: string;
  required: boolean;
  /** Shorthand used in error messages and docs. */
  type: 'string' | 'number' | 'json' | 'timestamp';
  description: string;
}

/**
 * The declared format. Anything not listed here is rejected rather than
 * ignored, so a misspelled `custmerEmail` surfaces as an error instead of
 * silently dropping a customer's email address.
 */
export const IMPORT_COLUMNS: ImportColumnSpec[] = [
  {
    column: 'externalId',
    required: false,
    type: 'string',
    description: "Source system's identifier for this invoice. Enables idempotency.",
  },
  {
    column: 'sellerPublicKey',
    required: true,
    type: 'string',
    description: 'Stellar account that issued the invoice.',
  },
  { column: 'amount', required: true, type: 'number', description: 'Amount owed.' },
  { column: 'assetCode', required: false, type: 'string', description: 'Defaults to XLM.' },
  {
    column: 'assetIssuer',
    required: false,
    type: 'string',
    description: 'Required when assetCode is not XLM.',
  },
  { column: 'sellerName', required: false, type: 'string', description: 'Seller display name.' },
  { column: 'sellerEmail', required: false, type: 'string', description: 'Seller contact email.' },
  { column: 'customerName', required: false, type: 'string', description: 'Customer display name.' },
  { column: 'customerEmail', required: false, type: 'string', description: 'Customer contact email.' },
  { column: 'description', required: false, type: 'string', description: 'Free text.' },
  {
    column: 'expiresInDays',
    required: false,
    type: 'number',
    description: 'Lifetime from createdAt. Defaults to policy, or derived from expiresAt.',
  },
  {
    column: 'createdAt',
    required: false,
    type: 'timestamp',
    description: 'Original creation time. Preserved for historical imports.',
  },
  {
    column: 'expiresAt',
    required: false,
    type: 'timestamp',
    description: 'Explicit expiry. Overrides expiresInDays when both are present.',
  },
  {
    column: 'memo',
    required: false,
    type: 'string',
    description: 'Settlement memo. Generated when omitted.',
  },
  {
    column: 'metadata',
    required: false,
    type: 'json',
    description: 'JSON object. Free-form passthrough.',
  },
];

/** Columns the format refuses outright, with the reason shown to the operator. */
export const REJECTED_COLUMNS: Record<string, string> = {
  status: 'lifecycle status is decided by the payment flow, not by a data file',
  paidAt: 'a payment timestamp is evidence; it cannot be asserted by an import',
  paymentTxHash: 'a transaction hash is evidence; it cannot be asserted by an import',
  payerPublicKey: 'the payer is recorded when settlement is observed',
  payerName: 'the payer is recorded when settlement is observed',
  payerEmail: 'the payer is recorded when settlement is observed',
  id: 'server-assigned; externalId is the identifier an import may supply',
  version: 'server-assigned optimistic concurrency counter',
};

export interface RawImportRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  values: Record<string, string>;
}

export interface ParseResult {
  rows: RawImportRow[];
  /** Fatal problems: the file could not be read as this format at all. */
  errors: string[];
  /** Columns present in the file, in file order. */
  header: string[];
  encoding: ImportEncoding;
}

const KNOWN_COLUMNS = new Set(IMPORT_COLUMNS.map((c) => c.column));

/**
 * RFC 4180 CSV reader. Handles quoted fields containing commas, escaped quotes
 * ("") and embedded newlines, and tolerates CRLF and a trailing newline.
 */
export function parseCsv(text: string): { rows: string[][]; unterminatedQuote: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawContent = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Skip rows that are entirely empty; a trailing newline is not a record.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    sawContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      sawContent = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      // Accept CRLF, LF and bare CR. Swallowing a bare CR instead would merge
      // two records into one field, which is silent data corruption.
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += ch;
      sawContent = true;
    }
  }

  if (inQuotes) return { rows, unterminatedQuote: true };
  if (sawContent || field !== '' || row.length > 0) endRow();

  return { rows, unterminatedQuote: false };
}

function parseCsvText(text: string): ParseResult {
  const errors: string[] = [];
  const { rows, unterminatedQuote } = parseCsv(text);

  if (unterminatedQuote) {
    return {
      rows: [],
      errors: ['malformed CSV: a quoted field is never closed'],
      header: [],
      encoding: 'csv',
    };
  }
  if (rows.length === 0) {
    return { rows: [], errors: ['file is empty: expected a header row'], header: [], encoding: 'csv' };
  }

  const header = rows[0]!.map((h) => h.trim());
  const seen = new Set<string>();
  for (const column of header) {
    if (seen.has(column)) errors.push(`duplicate column "${column}" in header`);
    seen.add(column);
  }
  for (const column of Object.keys(REJECTED_COLUMNS)) {
    if (seen.has(column)) errors.push(`column "${column}" is not importable: ${REJECTED_COLUMNS[column]}`);
  }
  for (const column of seen) {
    if (!KNOWN_COLUMNS.has(column)) errors.push(`unknown column "${column}": not part of the import format`);
  }
  for (const spec of IMPORT_COLUMNS) {
    if (spec.required && !seen.has(spec.column)) errors.push(`missing required column "${spec.column}"`);
  }

  if (errors.length > 0) return { rows: [], errors, header, encoding: 'csv' };

  const out: RawImportRow[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]!;
    if (cells.length > header.length) {
      errors.push(`row ${i + 1}: has ${cells.length} fields but the header declares ${header.length}`);
      continue;
    }
    const values: Record<string, string> = {};
    header.forEach((column, index) => {
      values[column] = (cells[index] ?? '').trim();
    });
    out.push({ line: i + 1, values });
  }

  return { rows: out, errors, header, encoding: 'csv' };
}

function parseNdjsonText(text: string): ParseResult {
  const errors: string[] = [];
  const rows: RawImportRow[] = [];
  const seenColumns = new Set<string>();

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`row ${i + 1}: invalid JSON (${(error as Error).message})`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`row ${i + 1}: expected a JSON object`);
      continue;
    }

    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'metadata' || key === 'createdAt' || key === 'expiresAt') {
        values[key] = typeof value === 'string' ? value : JSON.stringify(value);
      } else if (value === null || value === undefined) {
        values[key] = '';
      } else if (typeof value === 'object') {
        values[key] = JSON.stringify(value);
      } else {
        values[key] = String(value);
      }
    }
    for (const key of Object.keys(values)) seenColumns.add(key);
    rows.push({ line: i + 1, values });
  }

  const header = [...seenColumns];
  for (const column of Object.keys(REJECTED_COLUMNS)) {
    if (seenColumns.has(column)) {
      errors.push(`column "${column}" is not importable: ${REJECTED_COLUMNS[column]}`);
    }
  }
  for (const column of seenColumns) {
    if (!KNOWN_COLUMNS.has(column)) {
      errors.push(`unknown column "${column}": not part of the import format`);
    }
  }
  for (const spec of IMPORT_COLUMNS) {
    if (spec.required && !seenColumns.has(spec.column)) {
      errors.push(`missing required column "${spec.column}"`);
    }
  }

  if (errors.length > 0) return { rows: [], errors, header, encoding: 'ndjson' };
  return { rows, errors, header, encoding: 'ndjson' };
}

export function detectEncoding(fileName: string, text: string): ImportEncoding {
  if (/\.ndjson$/i.test(fileName) || /\.jsonl$/i.test(fileName)) return 'ndjson';
  if (/\.csv$/i.test(fileName)) return 'csv';
  // Fall back to sniffing: an NDJSON file's first non-blank line is an object.
  const first = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return first.startsWith('{') ? 'ndjson' : 'csv';
}

export function parseImportFile(fileName: string, text: string): ParseResult {
  if (text.trim() === '') {
    return { rows: [], errors: ['file is empty'], header: [], encoding: 'csv' };
  }
  return detectEncoding(fileName, text) === 'ndjson' ? parseNdjsonText(text) : parseCsvText(text);
}
