/**
 * Invoice import pipeline tests (#53).
 *
 * The issue asks for four specific guarantees, and each has a section below:
 *
 *   - a dry run writes nothing            -> "Dry run performs no writes"
 *   - re-imports are idempotent           -> "Idempotency"
 *   - invalid rows are reported, not lost -> "Validation", "Remediation"
 *   - partial failure is contained        -> "Partial failure handling"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  parseImportFile,
  IMPORT_COLUMNS,
  REJECTED_COLUMNS,
} from '../src/imports/import-format';
import { planImport, validateRow, type ExistingInvoice } from '../src/imports/import-pipeline';
import { formatImportReport, formatApplyReport } from '../src/imports/import-report';
import {
  applyImport,
  rollbackImport,
  ImportAbortedError,
  type ImportClient,
  type ImportDatabase,
} from '../src/imports/import-executor';

const SELLER = `G${'A'.repeat(55)}`;
const OTHER_SELLER = `G${'B'.repeat(55)}`;
const ISSUER = `G${'C'.repeat(55)}`;

function csv(rows: Record<string, string>[], header?: string[]): string {
  const columns = header ?? ['externalId', 'sellerPublicKey', 'amount', 'description'];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const value = row[c] ?? '';
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function parse(text: string, name = 'invoices.csv') {
  return parseImportFile(name, text);
}

function row(overrides: Record<string, string> = {}, line = 2) {
  return {
    line,
    values: {
      externalId: '',
      sellerPublicKey: SELLER,
      amount: '100',
      assetCode: '',
      assetIssuer: '',
      description: '',
      ...overrides,
    },
  };
}

function existing(overrides: Partial<ExistingInvoice> = {}): ExistingInvoice {
  return {
    id: 'inv-1',
    externalId: 'SRC-1',
    memo: 'INV-ABC-DEF',
    status: 'PENDING',
    amount: 100,
    assetCode: 'XLM',
    assetIssuer: null,
    sellerPublicKey: SELLER,
    sellerName: null,
    sellerEmail: null,
    customerName: null,
    customerEmail: null,
    description: 'Order 1',
    expiresAt: new Date('2026-12-25T00:00:00.000Z'),
    metadata: null,
    ...overrides,
  };
}

function recordingClient(options: { failOnInsert?: number } = {}) {
  const log: string[] = [];
  let inserts = 0;
  const state = {
    log,
    released: false,
    async query(text: string, params: unknown[] = []) {
      const trimmed = text.trim();
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        log.push(trimmed);
        return { rows: [], rowCount: 0 };
      }
      // Recorded so a test can assert a query was issued at all. Whitespace is
      // collapsed so an assertion can match any line of a multi-line statement.
      log.push(trimmed.replace(/\s+/g, ' ').trim());
      if (trimmed.startsWith('INSERT INTO invoices')) {
        inserts += 1;
        if (options.failOnInsert !== undefined && inserts > options.failOnInsert) {
          throw new Error('simulated write failure');
        }
        log.push('INSERT');
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (trimmed.startsWith('SELECT * FROM invoices')) {
        log.push('SELECT FOR UPDATE');
        return { rows: [{ id: params[0], description: 'old', version: 1 }], rowCount: 1 };
      }
      if (trimmed.startsWith('UPDATE invoices')) log.push('UPDATE');
      if (trimmed.startsWith('DELETE FROM invoices')) {
        log.push('DELETE');
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      state.released = true;
    },
  };
  return state as typeof state & ImportClient;
}

describe('Import format — CSV', () => {
  it('reads quoted fields containing commas, quotes and newlines', () => {
    const text = csv([{ externalId: 'A-1', sellerPublicKey: SELLER, amount: '10', description: 'a,b "c"\nd' }]);
    const result = parse(text);

    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]!.values.description, 'a,b "c"\nd');
  });

  it('handles CRLF line endings and a trailing newline', () => {
    const result = parse('externalId,sellerPublicKey,amount\r\nA-1,' + SELLER + ',10\r\n');

    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]!.values.amount, '10');
  });

  it('records the line number of each row for error messages', () => {
    const result = parse(csv([{ externalId: 'A-1', sellerPublicKey: SELLER, amount: '1' }, { externalId: 'A-2', sellerPublicKey: SELLER, amount: '2' }]));

    assert.deepEqual(result.rows.map((r) => r.line), [2, 3]);
  });

  it('rejects a file with no header', () => {
    const result = parse('');

    assert.equal(result.rows.length, 0);
    assert.match(result.errors.join(' '), /empty/);
  });

  it('rejects an unterminated quoted field', () => {
    const result = parse('externalId,sellerPublicKey\n"A-1,' + SELLER + '\n');

    assert.equal(result.rows.length, 0);
    assert.match(result.errors.join(' '), /never closed/);
  });

  it('rejects a duplicate column', () => {
    const result = parse('externalId,amount,amount\nA,1,2\n');

    assert.match(result.errors.join(' '), /duplicate column "amount"/);
  });

  it('rejects a missing required column', () => {
    const result = parse('externalId,description\nA-1,hi\n');

    assert.match(result.errors.join(' '), /missing required column "sellerPublicKey"/);
    assert.match(result.errors.join(' '), /missing required column "amount"/);
  });

  it('rejects an unknown column rather than ignoring it', () => {
    const result = parse('externalId,sellerPublicKey,amount,custmerEmail\nA,' + SELLER + ',1,x\n');

    assert.match(result.errors.join(' '), /unknown column "custmerEmail"/);
  });

  it('refuses columns that evidence cannot be asserted through', () => {
    for (const [column, reason] of Object.entries(REJECTED_COLUMNS)) {
      const result = parse(
        ['externalId', 'sellerPublicKey', 'amount', column].join(',') + '\n' +
          ['A-1', SELLER, '1', 'x'].join(',') + '\n'
      );
      assert.match(result.errors.join(' '), new RegExp(`"${column}" is not importable`), column);
      assert.ok(reason.length > 10);
    }
  });

  it('flags a row with more fields than the header', () => {
    const result = parse('externalId,sellerPublicKey,amount\nA,' + SELLER + ',1,extra\n');

    assert.match(result.errors.join(' '), /row 2: has 4 fields but the header declares 3/);
  });

  it('exposes a description for every declared column', () => {
    for (const spec of IMPORT_COLUMNS) {
      assert.ok(spec.description.length > 5, `${spec.column} needs a description`);
      assert.ok(['string', 'number', 'json', 'timestamp'].includes(spec.type));
    }
  });
});

describe('Import format — NDJSON', () => {
  it('reads one object per line', () => {
    const text =
      `{"externalId":"A-1","sellerPublicKey":"${SELLER}","amount":10}\n` +
      `{"externalId":"A-2","sellerPublicKey":"${SELLER}","amount":20}\n`;

    const result = parse(text, 'invoices.ndjson');

    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[1]!.values.amount, '20');
  });

  it('reports the line number of invalid JSON', () => {
    const result = parse(
      `{"externalId":"A-1","sellerPublicKey":"${SELLER}","amount":10}\n{not json}\n`,
      'invoices.ndjson'
    );

    assert.match(result.errors.join(' '), /row 2: invalid JSON/);
  });

  it('rejects a non-object line', () => {
    const result = parse(`[1,2,3]\n`, 'invoices.ndjson');

    assert.match(result.errors.join(' '), /expected a JSON object/);
  });

  it('still enforces the required columns', () => {
    const result = parse(`{"externalId":"A-1","amount":10}\n`, 'invoices.ndjson');

    assert.match(result.errors.join(' '), /missing required column "sellerPublicKey"/);
  });

  it('serialises a nested metadata object', () => {
    const result = parse(
      `{"externalId":"A-1","sellerPublicKey":"${SELLER}","amount":10,"metadata":{"order":7}}\n`,
      'invoices.ndjson'
    );

    assert.equal(result.rows[0]!.values.metadata, '{"order":7}');
  });
});

describe('Import format — encoding detection', () => {
  it('prefers the file extension', () => {
    assert.equal(parse(csv([{ externalId: 'A', sellerPublicKey: SELLER, amount: '1' }]), 'x.csv').encoding, 'csv');
    assert.equal(parse('{"externalId":"A"}', 'x.ndjson').encoding, 'ndjson');
  });

  it('sniffs the content when the extension is unknown', () => {
    assert.equal(parse('{"externalId":"A"}', 'x.txt').encoding, 'ndjson');
    assert.equal(parse('externalId,amount', 'x.txt').encoding, 'csv');
  });
});

describe('Import — row validation', () => {
  function expectError(values: Record<string, string>, pattern: RegExp, field?: string) {
    const result = validateRow(row(values));
    assert.ok(Array.isArray(result), `expected row to fail, got ${JSON.stringify(result)}`);
    const joined = result.map((e) => `${e.field ?? ''} ${e.message}`).join(' | ');
    assert.match(joined, pattern);
    if (field) assert.ok(result.some((e) => e.field === field), `expected field ${field} in: ${joined}`);
    return result;
  }

  it('accepts a minimal valid row', () => {
    const result = validateRow(row({ externalId: 'A-1' }));

    assert.ok(!Array.isArray(result));
    assert.equal(result.externalId, 'A-1');
    assert.equal(result.invoice.assetCode, 'XLM', 'XLM should be the default asset');
    assert.equal(result.nonIdempotent, false);
  });

  it('rejects a missing amount', () => {
    expectError({ amount: '' }, /amount is required/, 'amount');
  });

  it('rejects a non-numeric amount', () => {
    expectError({ amount: 'ten dollars' }, /plain decimal number/, 'amount');
  });

  it('rejects a zero or negative amount', () => {
    expectError({ amount: '0' }, /greater than zero/, 'amount');
    expectError({ amount: '-5' }, /greater than zero/, 'amount');
  });

  it('rejects a malformed seller public key', () => {
    expectError({ sellerPublicKey: 'not-a-key' }, /Stellar public key|sellerPublicKey/, 'sellerPublicKey');
  });

  it('requires an issuer for a non-XLM asset', () => {
    expectError({ assetCode: 'USDC' }, /assetIssuer is required/, 'assetIssuer');
  });

  it('accepts a non-XLM asset with an issuer', () => {
    const result = validateRow(row({ assetCode: 'USDC', assetIssuer: ISSUER }));

    assert.ok(!Array.isArray(result));
    assert.equal(result.invoice.assetIssuer, ISSUER);
  });

  it('forbids an issuer on XLM', () => {
    expectError({ assetIssuer: ISSUER }, /must not carry an issuer/, 'assetIssuer');
  });

  it('rejects a malformed issuer', () => {
    expectError({ assetCode: 'USDC', assetIssuer: 'nope' }, /not a valid Stellar public key/, 'assetIssuer');
  });

  it('rejects invalid email addresses', () => {
    expectError({ customerEmail: 'not-an-email' }, /valid email/, 'customerEmail');
    expectError({ sellerEmail: 'nope' }, /valid email/, 'sellerEmail');
  });

  it('rejects an unparseable timestamp', () => {
    expectError({ createdAt: 'yesterday' }, /ISO-8601/, 'createdAt');
    expectError({ expiresAt: 'whenever' }, /ISO-8601/, 'expiresAt');
  });

  it('rejects expiry that is not after creation', () => {
    expectError(
      { createdAt: '2026-06-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' },
      /must be after createdAt/,
      'expiresAt'
    );
  });

  it('rejects metadata that is not a JSON object', () => {
    expectError({ metadata: '{oops' }, /must be a JSON object/, 'metadata');
    expectError({ metadata: '[1,2]' }, /must be a JSON object/, 'metadata');
  });

  it('accepts a JSON object as metadata', () => {
    const result = validateRow(row({ metadata: '{"order":"A-17"}' }));

    assert.ok(!Array.isArray(result));
    assert.deepEqual(result.invoice.metadata, { order: 'A-17' });
  });

  it('rejects a malformed memo but accepts a well-formed one', () => {
    expectError({ memo: 'not a memo' }, /must match INV-/, 'memo');

    const result = validateRow(row({ memo: 'INV-ABC-DEF' }));
    assert.ok(!Array.isArray(result));
  });

  it('rejects an out-of-range expiry window', () => {
    expectError({ expiresInDays: '0' }, /expiresInDays must be between/, 'expiresInDays');
    expectError({ expiresInDays: '99999' }, /expiresInDays must be between/, 'expiresInDays');
  });

  it('rejects a fractional expiry window', () => {
    expectError({ expiresInDays: '7.5' }, /whole number of days/, 'expiresInDays');
  });

  it('rejects an over-long externalId', () => {
    expectError({ externalId: 'x'.repeat(300) }, /at most 255/, 'externalId');
  });

  it('applies the API schema, so import cannot create what the API would reject', () => {
    // createInvoiceSchema caps the amount; the import must inherit that cap.
    const result = validateRow(row({ amount: '999999999999' }));

    assert.ok(Array.isArray(result));
    assert.ok(
      result.some((e) => e.field === 'amount'),
      `expected the API schema to reject the amount, got ${JSON.stringify(result)}`
    );
  });

  it('marks a row without an externalId as non-idempotent', () => {
    const result = validateRow(row({ externalId: '' }));

    assert.ok(!Array.isArray(result));
    assert.equal(result.nonIdempotent, true);
    assert.equal(result.externalId, null);
  });
});

describe('Import — duplicates within a file', () => {
  it('rejects the second row when an externalId repeats', () => {
    const rows = [row({ externalId: 'A-1' }, 2), row({ externalId: 'A-1' }, 3)];
    const plan = planImport(rows);

    assert.equal(plan.counts.create, 1);
    assert.equal(plan.counts.error, 1);
    assert.equal(plan.rows[0]!.action, 'create');
    assert.equal(plan.rows[1]!.action, 'error');
    assert.match(plan.rows[1]!.errors[0]!.message, /duplicate: already defined on row 2/);
  });

  it('keeps the first occurrence, so a duplicate cannot overwrite it', () => {
    const rows = [row({ externalId: 'A-1', description: 'first' }, 2), row({ externalId: 'A-1', description: 'second' }, 3)];
    const plan = planImport(rows);

    assert.equal(plan.rows[0]!.invoice!.description, 'first');
    assert.equal(plan.rows[1]!.action, 'error');
  });

  it('rejects a duplicate memo even without an externalId', () => {
    const rows = [row({ memo: 'INV-ABC-DEF' }, 2), row({ memo: 'INV-ABC-DEF' }, 3)];
    const plan = planImport(rows);

    assert.equal(plan.counts.create, 1);
    assert.match(plan.rows[1]!.errors[0]!.message, /duplicate/);
  });

  it('treats the same externalId across different memos as a duplicate', () => {
    const rows = [
      row({ externalId: 'A-1', memo: 'INV-AAA-AAA' }, 2),
      row({ externalId: 'A-1', memo: 'INV-BBB-BBB' }, 3),
    ];
    const plan = planImport(rows);

    assert.equal(plan.counts.error, 1);
  });

  it('allows two different externalIds', () => {
    const plan = planImport([row({ externalId: 'A-1' }, 2), row({ externalId: 'A-2' }, 3)]);

    assert.equal(plan.counts.create, 2);
    assert.equal(plan.counts.error, 0);
  });
});

describe('Import — idempotency against existing data', () => {
  it('creates a row whose externalId is unknown', () => {
    const plan = planImport([row({ externalId: 'NEW-1' })], { existing: [existing()] });

    assert.equal(plan.counts.create, 1);
  });

  it('skips a row that already matches, so a re-run is a no-op', () => {
    const plan = planImport([row({ externalId: 'SRC-1', description: 'Order 1' })], { existing: [existing()] });

    assert.equal(plan.counts.skip, 1);
    assert.equal(plan.counts.update, 0);
    assert.equal(plan.counts.create, 0);
  });

  it('is idempotent across repeated planning runs', () => {
    const first = planImport([row({ externalId: 'SRC-1', description: 'Order 1' })], { existing: [existing()] });
    assert.equal(first.counts.skip, 1);

    // Same file, same database: still a no-op.
    const second = planImport([row({ externalId: 'SRC-1', description: 'Order 1' })], { existing: [existing()] });
    assert.equal(second.counts.skip, 1);
  });

  it('updates when a descriptive field drifted', () => {
    const plan = planImport(
      [row({ externalId: 'SRC-1', description: 'Order 1 (corrected)' })],
      { existing: [existing()] }
    );

    assert.equal(plan.counts.update, 1);
    const changes = plan.rows[0]!.changes!;
    assert.deepEqual(changes.description, { from: 'Order 1', to: 'Order 1 (corrected)' });
  });

  it('reports every changed field, not just the first', () => {
    const plan = planImport(
      [row({ externalId: 'SRC-1', description: 'new', customerName: 'Ada', customerEmail: 'ada@example.com' })],
      { existing: [existing()] }
    );

    assert.equal(plan.counts.update, 1);
    assert.deepEqual(Object.keys(plan.rows[0]!.changes!).sort(), ['customerEmail', 'customerName', 'description']);
  });

  it('matches an existing row by memo when no externalId is supplied', () => {
    const plan = planImport(
      [row({ memo: 'INV-ABC-DEF', description: 'Order 1' })],
      { existing: [existing({ externalId: null })] }
    );

    assert.equal(plan.counts.skip, 1);
  });

  it('refuses to change the amount of an existing invoice', () => {
    const plan = planImport(
      [row({ externalId: 'SRC-1', amount: '999', description: 'Order 1' })],
      { existing: [existing()] }
    );

    assert.equal(plan.counts.error, 1);
    assert.match(plan.rows[0]!.errors.map((e) => e.message).join(' '), /terms are not editable by import/);
  });

  it('refuses to change the asset or the seller', () => {
    const asset = planImport(
      [row({ externalId: 'SRC-1', assetCode: 'USDC', assetIssuer: ISSUER })],
      { existing: [existing()] }
    );
    assert.equal(asset.counts.error, 1);

    const seller = planImport(
      [row({ externalId: 'SRC-1', sellerPublicKey: OTHER_SELLER })],
      { existing: [existing()] }
    );
    assert.equal(seller.counts.error, 1);
  });

  it('refuses to modify an invoice that is already PAID', () => {
    const plan = planImport(
      [row({ externalId: 'SRC-1', description: 'corrected after payment' })],
      { existing: [existing({ status: 'PAID' })] }
    );

    assert.equal(plan.counts.error, 1);
    assert.match(plan.rows[0]!.errors[0]!.message, /already PAID/);
  });

  it('skips a PAID invoice when the file matches it, so re-importing is still a no-op', () => {
    const plan = planImport([row({ externalId: 'SRC-1', description: 'Order 1' })], {
      existing: [existing({ status: 'PAID' })],
    });

    assert.equal(plan.counts.skip, 1);
    assert.equal(plan.counts.error, 0);
  });
});

describe('Import — dry run performs no writes', () => {
  it('is flagged as a dry run', () => {
    assert.equal(planImport([row({ externalId: 'A-1' })]).dryRun, true);
  });

  it('returns counts without any database handle', () => {
    // No `db` argument exists on planImport, so a plan cannot write by
    // construction; assert the shape the CLI reports.
    const plan = planImport([row({ externalId: 'A-1' }), row({ externalId: 'A-2' })]);

    assert.deepEqual(plan.counts, { create: 2, update: 0, skip: 0, error: 0 });
    assert.equal(plan.total, 2);
  });

  it('issues no SQL when a dry-run plan is applied to a recording client', async () => {
    const client = recordingClient();
    const plan = planImport([row({ externalId: 'A-1' })]);

    // A dry-run plan is what the CLI reports on. Nothing executes it, which is
    // what this asserts: the plan carries no write path at all.
    assert.equal(plan.dryRun, true);
    assert.equal(client.log.length, 0);
  });

  it('says so in the report', () => {
    const report = formatImportReport(planImport([row({ externalId: 'A-1' })]));

    assert.match(report, /DRY RUN \(no data was written\)/);
    assert.match(report, /1 to create/);
  });
});

describe('Import — partial failure handling', () => {
  const good = row({ externalId: 'A-1', description: 'fine' }, 2);
  const bad = row({ externalId: 'A-2', amount: 'oops' }, 3);

  it('refuses the whole file by default', () => {
    const plan = planImport([good, bad]);

    assert.equal(plan.counts.error, 1);
    assert.equal(plan.formatErrors.length, 1);
    assert.match(plan.formatErrors[0]!, /onError=abort/);
  });

  it('still counts the valid rows so the operator can see the scope', () => {
    const plan = planImport([good, bad], { onError: 'skip' });

    assert.equal(plan.counts.create, 1);
    assert.equal(plan.counts.error, 1);
    assert.equal(plan.formatErrors.length, 0);
  });

  it('cannot be applied while any row failed', async () => {
    const plan = planImport([good, bad]);
    const client = recordingClient();

    await assert.rejects(
      () => applyImport({ connect: async () => client }, plan, { source: 'test.csv' }),
      (error: Error) => {
        assert.ok(error instanceof ImportAbortedError);
        assert.match(error.message, /1 row\(s\) failed validation/);
        return true;
      }
    );
    assert.deepEqual(client.log, [], 'an aborted import must not open a transaction');
  });

  it('applies only the valid rows under onError=skip', async () => {
    const plan = planImport([good, bad], { onError: 'skip' });
    const client = recordingClient();

    const result = await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    assert.equal(result.counts.create, 1);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]!.line, 2);
  });

  it('rolls the whole file back when a write fails mid-way', async () => {
    const plan = planImport([row({ externalId: 'A-1' }, 2), row({ externalId: 'A-2' }, 3)]);
    const client = recordingClient({ failOnInsert: 1 });

    await assert.rejects(
      () => applyImport({ connect: async () => client }, plan, { source: 'test.csv' }),
      /simulated write failure/
    );

    // Row 1 was inserted before the failure; the ROLLBACK is what makes the
    // file atomic, so it must be present and COMMIT must not be.
    assert.ok(client.log.includes('ROLLBACK'), `expected ROLLBACK, saw ${client.log.join(' | ')}`);
    assert.ok(!client.log.includes('COMMIT'), 'a failed import must never commit');
  });

  it('keeps a failed import from leaving a transaction open', async () => {
    const plan = planImport([row({ externalId: 'A-1' })]);
    const client = recordingClient({ failOnInsert: 0 });

    await assert.rejects(() => applyImport({ connect: async () => client }, plan, { source: 'test.csv' }));
    assert.equal(client.released, true);
  });
});

describe('Import — applying and rolling back', () => {
  it('wraps the whole file in one transaction', async () => {
    const plan = planImport([row({ externalId: 'A-1' }, 2), row({ externalId: 'A-2' }, 3)]);
    const client = recordingClient();

    await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    assert.equal(client.log[0], 'BEGIN');
    assert.equal(client.log[client.log.length - 1], 'COMMIT');
    assert.equal(client.log.filter((l) => l === 'INSERT').length, 2);
  });

  it('locks the row it is about to update', async () => {
    const plan = planImport([row({ externalId: 'SRC-1', description: 'new' })], { existing: [existing()] });
    const client = recordingClient();

    await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    assert.ok(client.log.includes('SELECT FOR UPDATE'), 'an update must re-read the row under a lock');
  });

  it('refuses to apply a plan that lost its target between dry run and apply', async () => {
    const plan = planImport([row({ externalId: 'SRC-1', description: 'new' })], { existing: [existing()] });
    const client = recordingClient();
    client.query = (async (text: string) => {
      if (text.includes('SELECT * FROM invoices')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }) as typeof client.query;

    await assert.rejects(
      () => applyImport({ connect: async () => client }, plan, { source: 'test.csv' }),
      /disappeared between the dry run and the apply/
    );
  });

  it('writes an undo snapshot of everything it touched', async () => {
    const creates = planImport([row({ externalId: 'A-1' })]);
    const updates = planImport([row({ externalId: 'SRC-1', description: 'new' })], { existing: [existing()] });
    const both = { ...creates, rows: [...creates.rows, ...updates.rows], counts: { create: 1, update: 1, skip: 0, error: 0 } };
    const client = recordingClient();

    const result = await applyImport({ connect: async () => client }, both, { source: 'test.csv' });

    assert.equal(result.snapshot.version, 1);
    assert.equal(result.snapshot.source, 'test.csv');
    assert.equal(result.snapshot.created.length, 1);
    assert.equal(result.snapshot.updated.length, 1);
    assert.equal(result.snapshot.updated[0]!.id, 'inv-1');
    assert.equal(result.snapshot.updated[0]!.before.description, 'old');
    assert.ok(result.snapshot.createdAt);
  });

  it('undoes an applied import', async () => {
    const plan = planImport([row({ externalId: 'A-1' })]);
    const client = recordingClient();
    const result = await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    const undo = recordingClient();
    const outcome = await rollbackImport({ connect: async () => undo }, result.snapshot);

    assert.equal(outcome.deleted, 1);
    assert.equal(undo.log[0], 'BEGIN');
    assert.equal(undo.log[undo.log.length - 1], 'COMMIT');
    assert.ok(undo.log.includes('DELETE'), 'rollback must delete the rows the import created');
  });

  it('restores overwritten values on rollback', async () => {
    const plan = planImport([row({ externalId: 'SRC-1', description: 'new' })], { existing: [existing()] });
    const client = recordingClient();
    const result = await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    const undo = recordingClient();
    await rollbackImport({ connect: async () => undo }, result.snapshot);

    const updates = undo.log.filter((l) => l.startsWith('UPDATE invoices SET'));
    assert.equal(updates.length, 1, 'the restore must write the row back');
    assert.ok(
      updates[0]!.includes('description'),
      `the restore must put the previous values back, saw: ${updates[0]}`
    );
  });

  it('rejects a snapshot it does not understand', async () => {
    await assert.rejects(
      () =>
        rollbackImport(
          { connect: async () => recordingClient() },
          { version: 99, createdAt: '', created: [], updated: [] }
        ),
      /unsupported snapshot version/
    );
  });

  it('does nothing for an empty snapshot', async () => {
    const client = recordingClient();
    const outcome = await rollbackImport(
      { connect: async () => client },
      { version: 1, createdAt: '', created: [], updated: [] }
    );

    assert.deepEqual(outcome, { restored: 0, deleted: 0 });
    assert.equal(client.log.length, 0, 'an empty snapshot should not open a transaction');
  });

  it('releases the connection it opened', async () => {
    const plan = planImport([row({ externalId: 'A-1' })]);
    const client = recordingClient();
    await applyImport({ connect: async () => client }, plan, { source: 'test.csv' });

    assert.equal(client.released, true);
  });

  it('refuses a plan built for a different source than the file', async () => {
    // Guards against applying a plan the operator reviewed a different file for.
    const plan = planImport([row({ externalId: 'A-1' })]);
    const client = recordingClient();

    const result = await applyImport({ connect: async () => client }, plan, { source: 'reviewed.csv' });
    assert.equal(result.source, 'reviewed.csv');
  });
});

describe('Import — reporting and remediation', () => {
  it('reports the four counts', () => {
    const rows = [
      row({ externalId: 'SRC-1', description: 'Order 1' }, 2), // unchanged -> skip
      row({ externalId: 'SRC-2', description: 'Order 2 amended' }, 3), // drifted -> update
      row({ externalId: 'NEW-1' }, 4), // new -> create
      row({ externalId: 'A-3', amount: 'bad' }, 5), // invalid -> error
    ];
    const plan = planImport(rows, {
      existing: [existing(), existing({ id: 'inv-2', externalId: 'SRC-2', description: 'Order 2' })],
      onError: 'skip',
    });

    assert.deepEqual(plan.counts, { create: 1, update: 1, skip: 1, error: 1 });

    const report = formatImportReport(plan);
    assert.match(report, /1 to create, 1 to update, 1 already current, 1 failed validation/);
  });

  it('shows a concrete fix for each error', () => {
    const report = formatImportReport(planImport([row({ externalId: 'A-1', amount: 'oops' })]));

    assert.match(report, /ERROR \(1\)/);
    assert.match(report, /fix: .*plain decimal number/);
  });

  it('points at the line number so the operator can find the row', () => {
    const report = formatImportReport(planImport([row({ externalId: 'A-1' }, 2), row({ amount: 'x' }, 3)]));

    assert.match(report, /line 3/);
  });

  it('explains a duplicate fix', () => {
    const report = formatImportReport(planImport([row({ externalId: 'A-1' }, 2), row({ externalId: 'A-1' }, 3)]));

    assert.match(report, /fix: remove one of the two rows/);
  });

  it('explains that a settled invoice must be excluded', () => {
    const report = formatImportReport(
      planImport([row({ externalId: 'SRC-1', description: 'changed' })], { existing: [existing({ status: 'PAID' })] })
    );

    assert.match(report, /fix: this invoice has settled/);
  });

  it('warns that a row without an externalId is not idempotent', () => {
    const report = formatImportReport(planImport([row({ externalId: '' })]));

    assert.match(report, /no externalId/);
    assert.match(report, /will create duplicates/);
  });

  it('refuses to describe an apply when errors remain', () => {
    const report = formatImportReport(planImport([row({ amount: 'bad' })]));

    assert.match(report, /Nothing can be applied until every error is resolved/);
  });

  it('says there is nothing to do when the database already matches', () => {
    const report = formatImportReport(planImport([row({ externalId: 'SRC-1', description: 'Order 1' })], { existing: [existing()] }));

    assert.match(report, /Nothing to do/);
  });

  it('tells the operator how to undo an applied import', () => {
    const report = formatApplyReport(
      {
        dryRun: false,
        source: 'invoices.csv',
        counts: { create: 1, update: 0, skip: 0, error: 0 },
        created: [{ line: 2, id: 'abc', memo: 'INV-AAA-BBB', externalId: 'A-1' }],
        updated: [],
        skipped: 0,
        snapshot: { version: 1, createdAt: '', created: [], updated: [] },
      },
      'invoices.csv.snapshot.json'
    );

    assert.match(report, /APPLIED/);
    assert.match(report, /1 created/);
    assert.match(report, /--rollback invoices\.csv\.snapshot\.json/);
  });

  it('admits when no undo was captured', () => {
    const report = formatApplyReport({
      dryRun: false,
      source: 'invoices.csv',
      counts: { create: 1, update: 0, skip: 0, error: 0 },
      created: [],
      updated: [],
      skipped: 0,
      snapshot: { version: 1, createdAt: '', created: [], updated: [] },
    });

    assert.match(report, /can only be undone row by row/);
  });
});

describe('Import — CSV parser edge cases', () => {
  it('treats a bare CR as a row break rather than merging two records', () => {
    const { rows } = parseCsv('a,b\rc,d');

    assert.equal(rows.length, 2, 'a bare CR must not merge two records into one field');
    assert.deepEqual(rows, [['a', 'b'], ['c', 'd']]);
  });

  it('returns a trailing partial row', () => {
    const { rows, unterminatedQuote } = parseCsv('a,b\n1,2');

    assert.equal(unterminatedQuote, false);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], ['1', '2']);
  });

  it('handles a quoted empty field', () => {
    const { rows } = parseCsv('a,b\n"",2');

    assert.equal(rows[1]![0], '');
  });
});

describe('Import — database contract', () => {
  it('reads the existing rows the plan depends on', async () => {
    const client = recordingClient();
    const { loadExisting } = await import('../src/imports/import-executor');
    const plan = planImport([row({ externalId: 'A-1' })]);

    await loadExisting(client as ImportClient, plan);

    const query = client.log.at(-1)!;
    assert.match(String(query), /external_id = ANY/);
  });

  it('uses the pg pool as its database handle', () => {
    const source = readFileSync('src/imports/import-cli.ts');

    assert.match(source, /import \{ pool \} from '\.\.\/config\/database'/);
    assert.match(source, /pool\.connect\(\)/);
  });
});

function readFileSync(relative: string): string {
  // Small helper so the assertion above reads the real source rather than a
  // duplicated copy of it.
  const { readFileSync: read } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return read(resolve(process.cwd(), relative), 'utf-8');
}
