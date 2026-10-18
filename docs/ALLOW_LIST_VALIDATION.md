# Allow-list validation: URLs, file types, destinations (#291)

Module: [`backend/src/security/allow-list.ts`](../backend/src/security/allow-list.ts).
Everything is **default-deny**: a value passes only when it matches an explicit
entry.

| Check | Where it runs | Rule |
|-------|---------------|------|
| Outbound URL | `createHttpApiTransport({ allowList })`, when the transport is built | `https:` only, no `user:pass@`, default port only, host on the list. An IP literal passes only if that exact literal is listed. |
| Destination | Same transport, before **every** send | Every address the host resolves to must be public (not in an IANA special-purpose block). |
| Import file type | `npm run db:import`, before the file is read | Regular file, extension `.csv` / `.ndjson` / `.jsonl`, at most `IMPORT_MAX_BYTES` (default 10 MiB). |
| Import file content | `npm run db:import`, after reading | Valid UTF-8 with no NUL bytes, and the first line must match the extension. |

## Configuring the email provider allow-list

```ts
createHttpApiTransport({
  endpoint: 'https://api.provider.example/v1/send',
  token, from,
  allowList: { hosts: ['api.provider.example'] }, // or '*.provider.example'
});
```

- `*.provider.example` matches `eu.provider.example`, but not `provider.example` itself.
- Matching ignores case and a trailing dot.
- Requests use `redirect: 'error'`. A provider that redirects a POST would re-send the message body to a host nobody listed, so a redirect fails the send instead.

## Failure codes

| Code | Meaning | Delivery category | Retryable |
|------|---------|-------------------|-----------|
| `URL_*` | Endpoint rejected at startup | thrown, process should not start | — |
| `DESTINATION_UNRESOLVABLE` | DNS lookup failed or returned nothing | `transient` | yes |
| `DESTINATION_NOT_PUBLIC` | A resolved address is private, loopback, link-local (cloud metadata), CGNAT, multicast or reserved | `config` | no |
| `FILE_NOT_REGULAR`, `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `FILE_NOT_TEXT`, `FILE_CONTENT_MISMATCH` | Import file refused | CLI exit code `1` | after fixing the file |

## Operational edge cases

- **DNS rebinding.** The resolved addresses are checked on every send, not only at startup. `fetch` then resolves the name again, so a resolver that answers differently within milliseconds can still win that race. Closing it completely needs an egress proxy or firewall that enforces the same blocks; this check is the in-process layer.
- **The block list** contains the entries the IANA IPv4/IPv6 Special-Purpose Address Registries mark as not globally reachable, plus multicast. IPv4-mapped IPv6 (`::ffff:10.0.0.1`, `::ffff:a00:1`) is matched against the IPv4 rules by Node's `net.BlockList` itself.
- **NAT64:** the well-known prefix `64:ff9b::/96` is **allowed**. IANA lists it as globally reachable, IPv6-only networks with DNS64 reach public providers through it, and RFC 6052 §3.1 requires translators to drop it when it embeds a non-global IPv4 address. The local-use prefix `64:ff9b:1::/48` (RFC 8215) is blocked.
- **Spreadsheet exports** often start with a UTF-8 BOM. It is stripped, not rejected.
- **A file without an extension, or with an unknown one,** is refused. It is no longer guessed from its content. This is the only behaviour change for the import CLI.

## Recovery and rollback

- An allow-list rejection makes no change anywhere: the email is never sent and the import never reads rows.
- Recover by fixing the configuration (add the host, or move the provider to a public address) or the file, then retry.
- To roll back, revert the commit. Callers that do not pass `allowList` behave exactly as before.

## Contract and migration

- `createHttpApiTransport` gains an optional `allowList`. Without it the transport only adds `redirect: 'error'`.
- The import CLI now refuses files with a missing or unknown extension. Rename such files to `.csv` / `.ndjson`.
- No schema change.
