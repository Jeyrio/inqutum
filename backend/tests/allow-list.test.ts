/**
 * Strict allow-list validation for URLs, file types and destinations (#291).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AllowListViolation,
  checkImportFileContent,
  checkImportFileStat,
  checkOutboundUrl,
  checkPublicDestination,
  isPublicAddress,
} from '../src/security/allow-list';
import { EmailDeliveryError, createHttpApiTransport } from '../src/notifications/email-delivery';

const POLICY = { hosts: ['api.mail.example', '*.provider.example'] };
const file = (size: number, isFile = true) => ({ size, isFile: () => isFile });
const bytes = (text: string) => new TextEncoder().encode(text);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as AllowListViolation).code;
  }
  return 'passed';
};

describe('Allow-list — outbound URLs', () => {
  it('normal path: accepts an exact host and a wildcard subdomain over https', () => {
    assert.equal(checkOutboundUrl('https://api.mail.example/v1/send', POLICY).hostname, 'api.mail.example');
    assert.equal(checkOutboundUrl('https://eu.provider.example/send', POLICY).hostname, 'eu.provider.example');
    assert.equal(checkOutboundUrl('https://API.Mail.Example./send', POLICY).hostname, 'api.mail.example.');
  });

  it('failure path: rejects every value that is not explicitly allowed', () => {
    const cases: Array<[string, string]> = [
      ['http://api.mail.example/send', 'URL_SCHEME_NOT_ALLOWED'],
      ['javascript:alert(1)', 'URL_SCHEME_NOT_ALLOWED'],
      ['https://user:pass@api.mail.example/', 'URL_CREDENTIALS_NOT_ALLOWED'],
      ['https://api.mail.example:8443/', 'URL_PORT_NOT_ALLOWED'],
      ['https://evil.example/', 'URL_HOST_NOT_ALLOWED'],
      ['https://api.mail.example.evil.example/', 'URL_HOST_NOT_ALLOWED'],
      ['https://provider.example/', 'URL_HOST_NOT_ALLOWED'],
      ['https://127.0.0.1/', 'URL_HOST_NOT_ALLOWED'],
      ['https://api.mail.example/ send', 'URL_INVALID'],
      ['not a url', 'URL_INVALID'],
    ];
    for (const [url, expected] of cases) assert.equal(code(() => checkOutboundUrl(url, POLICY)), expected, url);
    assert.equal(code(() => checkOutboundUrl(42, POLICY)), 'URL_INVALID');
  });

  it('keeps the default https port, which WHATWG URL normalises away', () => {
    assert.equal(code(() => checkOutboundUrl('https://api.mail.example:443/send', POLICY)), 'passed');
  });

  it('an empty allow-list denies everything', () => {
    assert.equal(code(() => checkOutboundUrl('https://api.mail.example/', { hosts: [] })), 'URL_HOST_NOT_ALLOWED');
  });
});

describe('Allow-list — destinations', () => {
  it('classifies special-purpose ranges as non-public', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.88.99.2', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
      '::ffff:a00:1', '64:ff9b:1::1', '2001:db8::1', '3fff::1', '5f00::1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    // 64:ff9b::/96 is how DNS64 networks reach public IPv4 hosts (RFC 6052).
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
    assert.equal(isPublicAddress('not-an-ip'), false);
  });

  it('requires every resolved address to be public', async () => {
    const lookup = async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }];
    await assert.rejects(checkPublicDestination('api.mail.example', lookup), (e: AllowListViolation) => e.code === 'DESTINATION_NOT_PUBLIC');
    assert.deepEqual(await checkPublicDestination('api.mail.example', async () => [{ address: '8.8.8.8' }]), ['8.8.8.8']);
  });

  it('reports a DNS failure as unresolvable, not as allowed', async () => {
    const lookup = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await assert.rejects(checkPublicDestination('api.mail.example', lookup), (e: AllowListViolation) => e.code === 'DESTINATION_UNRESOLVABLE');
    await assert.rejects(checkPublicDestination('api.mail.example', async () => []), (e: AllowListViolation) => e.code === 'DESTINATION_UNRESOLVABLE');
  });
});

describe('Allow-list — email provider transport', () => {
  const MESSAGE = { to: 'client@example.com', subject: 'Invoice' };
  const options = (lookup: () => Promise<Array<{ address: string }>>, fetchImpl: typeof fetch) => ({
    endpoint: 'https://api.mail.example/send',
    token: 'token',
    from: 'billing@example.com',
    fetchImpl,
    allowList: { hosts: ['api.mail.example'], lookup },
  });

  it('authorization path: refuses to build a transport for an unlisted endpoint', () => {
    assert.throws(
      () => createHttpApiTransport({ ...options(async () => [], fetch), endpoint: 'https://evil.example/send' }),
      (e: AllowListViolation) => e.code === 'URL_HOST_NOT_ALLOWED'
    );
  });

  it('normal path: sends with redirects disabled once the destination is public', async () => {
    let init: RequestInit | undefined;
    const transport = createHttpApiTransport(
      options(async () => [{ address: '8.8.8.8' }], (async (_url: unknown, request?: RequestInit) => {
        init = request;
        return Response.json({ id: 'prov_1' });
      }) as typeof fetch)
    );
    assert.equal((await transport.send(MESSAGE)).providerMessageId, 'prov_1');
    assert.equal(init?.redirect, 'error');
  });

  it('failure path: a rebinding to a private address is a non-retryable config error and nothing is sent', async () => {
    let called = false;
    const transport = createHttpApiTransport(
      options(async () => [{ address: '169.254.169.254' }], (async () => {
        called = true;
        return Response.json({});
      }) as typeof fetch)
    );
    const error = (await transport.send(MESSAGE).catch((e) => e)) as EmailDeliveryError;
    assert.equal(error.category, 'config');
    assert.equal(error.retryable, false);
    assert.equal(called, false);
  });

  it('retry path: a DNS outage is transient and retryable', async () => {
    const transport = createHttpApiTransport(
      options(async () => {
        throw new Error('EAI_AGAIN');
      }, fetch)
    );
    const error = (await transport.send(MESSAGE).catch((e) => e)) as EmailDeliveryError;
    assert.equal(error.category, 'transient');
    assert.equal(error.retryable, true);
  });
});

describe('Allow-list — import file types', () => {
  it('normal path: maps allowed extensions to their encoding', () => {
    assert.equal(checkImportFileStat('/data/invoices.csv', file(10)), 'csv');
    assert.equal(checkImportFileStat('/data/INVOICES.NDJSON', file(10)), 'ndjson');
    assert.equal(checkImportFileStat('/data/invoices.jsonl', file(10)), 'ndjson');
  });

  it('failure path: refuses other types, special files and oversized files before reading', () => {
    assert.equal(code(() => checkImportFileStat('/data/invoices.xlsx', file(10))), 'FILE_TYPE_NOT_ALLOWED');
    assert.equal(code(() => checkImportFileStat('/data/invoices', file(10))), 'FILE_TYPE_NOT_ALLOWED');
    assert.equal(code(() => checkImportFileStat('/data/invoices.csv.exe', file(10))), 'FILE_TYPE_NOT_ALLOWED');
    assert.equal(code(() => checkImportFileStat('/dev/stdin.csv', file(0, false))), 'FILE_NOT_REGULAR');
    assert.equal(code(() => checkImportFileStat('/data/big.csv', file(11), 10)), 'FILE_TOO_LARGE');
  });

  it('checks that the content is UTF-8 text matching its extension', () => {
    assert.equal(checkImportFileContent('csv', bytes('﻿externalId,amount\n')).text, 'externalId,amount\n');
    assert.equal(checkImportFileContent('ndjson', bytes('\n{"amount":1}\n')).encoding, 'ndjson');
    assert.equal(code(() => checkImportFileContent('csv', new Uint8Array([0x61, 0x00, 0x62]))), 'FILE_NOT_TEXT');
    assert.equal(code(() => checkImportFileContent('csv', new Uint8Array([0xff, 0xfe, 0x41]))), 'FILE_NOT_TEXT');
    assert.equal(code(() => checkImportFileContent('ndjson', bytes('externalId,amount\n'))), 'FILE_CONTENT_MISMATCH');
    assert.equal(code(() => checkImportFileContent('csv', bytes('{"amount":1}\n'))), 'FILE_CONTENT_MISMATCH');
  });
});
