import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInvoiceCursor,
  decodeInvoiceCursor,
  validateInvoiceCursor,
  compareNewestFirst,
  isAfterCursor,
} from '../src/storage/invoice-cursor';

const validUUID = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
const validUUID2 = 'b2c3d4e5-f6a1-4b2c-9d3e-4f5a6b7c8d9e';
const validDate = new Date('2026-08-15T12:30:45.123Z');

// -------------------------------------------------------- encodeInvoiceCursor

test('encodeInvoiceCursor encodes a valid invoice cursor to base64url', () => {
  const encoded = encodeInvoiceCursor({ createdAt: validDate, id: validUUID });
  assert.equal(typeof encoded, 'string');
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);

  const decoded = decodeInvoiceCursor(encoded);
  assert.ok(decoded);
  assert.equal(decoded.createdAt.toISOString(), validDate.toISOString());
  assert.equal(decoded.id, validUUID);
});

test('encodeInvoiceCursor supports string and number timestamps', () => {
  const fromIso = encodeInvoiceCursor({
    createdAt: '2026-08-15T12:30:45.123Z',
    id: validUUID,
  });
  const decodedIso = decodeInvoiceCursor(fromIso);
  assert.equal(decodedIso?.createdAt.toISOString(), '2026-08-15T12:30:45.123Z');

  const fromNumber = encodeInvoiceCursor({
    createdAt: validDate.getTime(),
    id: validUUID,
  });
  const decodedNum = decodeInvoiceCursor(fromNumber);
  assert.equal(decodedNum?.createdAt.toISOString(), validDate.toISOString());
});

test('encodeInvoiceCursor rejects invalid invoice input', () => {
  assert.throws(
    // @ts-expect-error test invalid input
    () => encodeInvoiceCursor(null),
    TypeError
  );

  assert.throws(
    () => encodeInvoiceCursor({ createdAt: validDate, id: 'not-a-uuid' }),
    TypeError
  );

  assert.throws(
    () => encodeInvoiceCursor({ createdAt: 'invalid-date', id: validUUID }),
    RangeError
  );
});

// -------------------------------------------------------- decodeInvoiceCursor

test('decodeInvoiceCursor decodes valid base64url cursor', () => {
  const raw = `${validDate.toISOString()}|${validUUID}`;
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  const decoded = decodeInvoiceCursor(encoded);

  assert.ok(decoded);
  assert.equal(decoded.createdAt.getTime(), validDate.getTime());
  assert.equal(decoded.id, validUUID);
});

test('decodeInvoiceCursor normalizes UUID to lowercase', () => {
  const upperUUID = validUUID.toUpperCase();
  const raw = `${validDate.toISOString()}|${upperUUID}`;
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  const decoded = decodeInvoiceCursor(encoded);

  assert.ok(decoded);
  assert.equal(decoded.id, validUUID.toLowerCase());
});

test('decodeInvoiceCursor rejects non-string and empty inputs', () => {
  for (const input of [null, undefined, 123, {}, [], '', '   ']) {
    assert.equal(decodeInvoiceCursor(input), null);
  }
});

test('decodeInvoiceCursor rejects excessively long strings (DoS protection)', () => {
  const longString = 'a'.repeat(513);
  assert.equal(decodeInvoiceCursor(longString), null);
});

test('decodeInvoiceCursor rejects non-base64url characters', () => {
  for (const bad of ['abc+def', 'abc/def', 'abc=def', 'abc!def']) {
    assert.equal(decodeInvoiceCursor(bad), null);
  }
});

test('decodeInvoiceCursor rejects tampered payload shapes', () => {
  // Missing pipe
  const noPipe = Buffer.from(`${validDate.toISOString()}${validUUID}`).toString('base64url');
  assert.equal(decodeInvoiceCursor(noPipe), null);

  // Extra pipe
  const extraPipe = Buffer.from(`${validDate.toISOString()}|${validUUID}|extra`).toString('base64url');
  assert.equal(decodeInvoiceCursor(extraPipe), null);

  // SQL injection attempt in id
  const sqlInjection = Buffer.from(`${validDate.toISOString()}|1 OR 1=1`).toString('base64url');
  assert.equal(decodeInvoiceCursor(sqlInjection), null);

  // Non-ISO date
  const badDate = Buffer.from(`not-a-date|${validUUID}`).toString('base64url');
  assert.equal(decodeInvoiceCursor(badDate), null);

  // Year only date
  const yearOnly = Buffer.from(`2026|${validUUID}`).toString('base64url');
  assert.equal(decodeInvoiceCursor(yearOnly), null);
});

// -------------------------------------------------------- validateInvoiceCursor

test('validateInvoiceCursor returns success for valid cursor', () => {
  const encoded = encodeInvoiceCursor({ createdAt: validDate, id: validUUID });
  const result = validateInvoiceCursor(encoded);

  assert.equal(result.valid, true);
  assert.ok(result.cursor);
  assert.equal(result.cursor.id, validUUID);
  assert.equal(result.errorCode, undefined);
});

test('validateInvoiceCursor returns stable INVALID_CURSOR code and recovery guidance', () => {
  for (const bad of ['garbage', '', null, undefined, 'bad!cursor']) {
    const result = validateInvoiceCursor(bad);
    assert.equal(result.valid, false);
    assert.equal(result.cursor, null);
    assert.equal(result.errorCode, 'INVALID_CURSOR');
    assert.equal(result.errorMessage, 'cursor is not valid; restart from the first page');
  }
});

// -------------------------------------------------------- compareNewestFirst

test('compareNewestFirst sorts newer dates first', () => {
  const earlier = { createdAt: new Date('2026-08-01T00:00:00.000Z'), id: validUUID };
  const later = { createdAt: new Date('2026-08-02T00:00:00.000Z'), id: validUUID };

  assert.ok(compareNewestFirst(later, earlier) < 0);
  assert.ok(compareNewestFirst(earlier, later) > 0);
  assert.equal(compareNewestFirst(later, later), 0);
});

test('compareNewestFirst breaks date ties with id descending', () => {
  const rowA = { createdAt: validDate, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const rowB = { createdAt: validDate, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };

  // 'bbbb...' is greater than 'aaaa...', so rowB comes first when sorting DESC
  assert.ok(compareNewestFirst(rowB, rowA) < 0);
  assert.ok(compareNewestFirst(rowA, rowB) > 0);
});

test('compareNewestFirst handles malformed dates safely without throwing', () => {
  const badRow = { createdAt: 'invalid-date', id: validUUID };
  const goodRow = { createdAt: validDate, id: validUUID2 };

  // Does not throw; treats invalid date safely
  const diff = compareNewestFirst(badRow, goodRow);
  assert.equal(typeof diff, 'number');
});

// -------------------------------------------------------- isAfterCursor

test('isAfterCursor returns true for rows strictly older or tie-broken after cursor', () => {
  const cursor = { createdAt: new Date('2026-08-10T12:00:00.000Z'), id: validUUID2 };

  const olderRow = { createdAt: new Date('2026-08-09T12:00:00.000Z'), id: validUUID };
  assert.equal(isAfterCursor(olderRow, cursor), true);

  const newerRow = { createdAt: new Date('2026-08-11T12:00:00.000Z'), id: validUUID };
  assert.equal(isAfterCursor(newerRow, cursor), false);

  const exactRow = { createdAt: cursor.createdAt, id: cursor.id };
  assert.equal(isAfterCursor(exactRow, cursor), false);
});

test('isAfterCursor returns false for null or undefined inputs', () => {
  const cursor = { createdAt: validDate, id: validUUID };
  // @ts-expect-error test null input
  assert.equal(isAfterCursor(null, cursor), false);
  // @ts-expect-error test undefined input
  assert.equal(isAfterCursor({ createdAt: validDate, id: validUUID }, undefined), false);
});
