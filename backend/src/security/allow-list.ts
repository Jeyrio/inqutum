/**
 * Strict allow-list validation for URLs, file types and destinations (#291).
 *
 * Everything here is default-deny: a value passes only when it matches an
 * explicit entry, never because it fails to match a block-list.
 *
 *  - URLs: an outbound URL must be https, carry no credentials, use the default
 *    port and name a host that is on the configured allow-list. An IP literal
 *    passes only when that exact literal is listed.
 *  - Destinations: the addresses a hostname resolves to must all be publicly
 *    routable. This is checked at send time, so a listed hostname whose DNS is
 *    later pointed at 127.0.0.1 or a cloud metadata address is still refused.
 *  - File types: an import file must be a regular file with an allow-listed
 *    extension, within the size cap, valid UTF-8 with no NUL bytes, and its
 *    content must agree with its extension.
 */

import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';

export type AllowListCode =
  | 'URL_INVALID'
  | 'URL_SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS_NOT_ALLOWED'
  | 'URL_PORT_NOT_ALLOWED'
  | 'URL_HOST_NOT_ALLOWED'
  | 'DESTINATION_UNRESOLVABLE'
  | 'DESTINATION_NOT_PUBLIC'
  | 'FILE_NOT_REGULAR'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'FILE_NOT_TEXT'
  | 'FILE_CONTENT_MISMATCH';

export class AllowListViolation extends Error {
  constructor(readonly code: AllowListCode, message: string) {
    super(message);
    this.name = 'AllowListViolation';
  }
}

// ── URLs ──────────────────────────────────────────────────────────────────

/**
 * Host entries are exact hostnames (`api.example.com`) or a subdomain wildcard
 * (`*.example.com`, which matches `a.example.com` but not `example.com`).
 */
export interface OutboundUrlPolicy {
  hosts: readonly string[];
}

const stripTrailingDot = (host: string): string => (host.endsWith('.') ? host.slice(0, -1) : host);

function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = stripTrailingDot(hostname.toLowerCase());
  return hosts.some((entry) => {
    const rule = stripTrailingDot(entry.trim().toLowerCase());
    if (rule.startsWith('*.')) return host.endsWith(rule.slice(1));
    return rule !== '' && host === rule;
  });
}

/**
 * Returns the parsed URL when it satisfies the policy, otherwise throws.
 * O(H) in the number of allow-list entries; O(1) extra space.
 */
export function checkOutboundUrl(value: unknown, policy: OutboundUrlPolicy): URL {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F\s\\]/.test(value.trim()) || value.trim() === '') {
    throw new AllowListViolation('URL_INVALID', 'URL must be a non-empty string without whitespace or control characters');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AllowListViolation('URL_INVALID', 'URL could not be parsed');
  }
  if (url.protocol !== 'https:') {
    throw new AllowListViolation('URL_SCHEME_NOT_ALLOWED', `URL scheme ${url.protocol} is not allowed; use https:`);
  }
  if (url.username || url.password) {
    throw new AllowListViolation('URL_CREDENTIALS_NOT_ALLOWED', 'URL must not embed credentials');
  }
  // WHATWG URL drops a port equal to the scheme default, so '' means 443 here.
  if (url.port !== '') {
    throw new AllowListViolation('URL_PORT_NOT_ALLOWED', `URL port ${url.port} is not allowed; only the default https port is`);
  }
  if (!hostAllowed(url.hostname, policy.hosts)) {
    throw new AllowListViolation('URL_HOST_NOT_ALLOWED', `Host ${url.hostname} is not on the outbound allow-list`);
  }
  return url;
}

// ── Destinations ──────────────────────────────────────────────────────────

/**
 * Blocks the IANA IPv4 and IPv6 Special-Purpose Address Registries mark as not
 * globally reachable, plus multicast. 192.0.0.0/24 also covers two anycast /32s
 * IANA lists as reachable; no email API lives there. 64:ff9b::/96 (NAT64) is
 * deliberately absent: IANA lists it as reachable, DNS64 networks reach public
 * hosts through it, and RFC 6052 s3.1 requires translators to drop it when it
 * embeds a non-global IPv4 address.
 */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast (RFC 7526)
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use IPv4/IPv6 translation (RFC 8215)
  ['100::', 64], // discard-only
  ['100:0:0:1::', 64], // dummy prefix
  ['2001:2::', 48], // benchmarking
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/**
 * True only for a syntactically valid, globally routable IP address. BlockList
 * matches IPv4-mapped IPv6 (`::ffff:10.0.0.1`, `::ffff:a00:1`) against the IPv4
 * rules itself. O(1).
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const systemLookup: AddressLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolves the hostname and requires every returned address to be public, so
 * one private record in a round-robin set cannot slip through.
 * O(A) in the number of resolved addresses.
 */
export async function checkPublicDestination(hostname: string, lookup: AddressLookup = systemLookup): Promise<string[]> {
  const host = stripTrailingDot(hostname.replace(/^\[|\]$/g, ''));
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host)).map((entry) => entry.address);
    } catch (error) {
      throw new AllowListViolation('DESTINATION_UNRESOLVABLE', `Could not resolve ${host}: ${(error as Error).message}`);
    }
  }
  if (addresses.length === 0) {
    throw new AllowListViolation('DESTINATION_UNRESOLVABLE', `${host} resolved to no addresses`);
  }
  const blocked = addresses.find((address) => !isPublicAddress(address));
  if (blocked) {
    throw new AllowListViolation('DESTINATION_NOT_PUBLIC', `${host} resolves to non-public address ${blocked}`);
  }
  return addresses;
}

// ── File types ────────────────────────────────────────────────────────────

/** Extension → import encoding. Anything else is refused, never sniffed. */
export const IMPORT_FILE_TYPES: Readonly<Record<string, 'csv' | 'ndjson'>> = {
  '.csv': 'csv',
  '.ndjson': 'ndjson',
  '.jsonl': 'ndjson',
};

export const DEFAULT_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export interface ImportFileCheck {
  encoding: 'csv' | 'ndjson';
  text: string;
}

/** Called before the file is read, so an oversized or special file is never loaded. O(1). */
export function checkImportFileStat(
  fileName: string,
  stat: { isFile(): boolean; size: number },
  maxBytes = DEFAULT_IMPORT_MAX_BYTES
): 'csv' | 'ndjson' {
  if (!stat.isFile()) {
    throw new AllowListViolation('FILE_NOT_REGULAR', `${fileName} is not a regular file`);
  }
  const extension = /\.[^./\\]+$/.exec(fileName.toLowerCase())?.[0] ?? '';
  const encoding = IMPORT_FILE_TYPES[extension];
  if (!encoding) {
    throw new AllowListViolation(
      'FILE_TYPE_NOT_ALLOWED',
      `File type "${extension || '(none)'}" is not allowed; use ${Object.keys(IMPORT_FILE_TYPES).join(', ')}`
    );
  }
  if (stat.size > maxBytes) {
    throw new AllowListViolation('FILE_TOO_LARGE', `File is ${stat.size} bytes; the limit is ${maxBytes}`);
  }
  return encoding;
}

/**
 * Decodes the bytes and checks they agree with the declared encoding.
 * O(n) time and O(n) space in the file size.
 */
export function checkImportFileContent(encoding: 'csv' | 'ndjson', bytes: Uint8Array): ImportFileCheck {
  if (bytes.includes(0)) {
    throw new AllowListViolation('FILE_NOT_TEXT', 'File contains NUL bytes; it is not a text file');
  }
  let text: string;
  try {
    // ignoreBOM: false strips a leading UTF-8 BOM, which spreadsheet exports add.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AllowListViolation('FILE_NOT_TEXT', 'File is not valid UTF-8');
  }
  const first = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  if (encoding === 'ndjson' && first !== '' && !first.startsWith('{')) {
    throw new AllowListViolation('FILE_CONTENT_MISMATCH', 'An NDJSON file must start with a JSON object');
  }
  if (encoding === 'csv' && first.startsWith('{')) {
    throw new AllowListViolation('FILE_CONTENT_MISMATCH', 'A .csv file must start with a header row, not JSON');
  }
  return { encoding, text };
}
