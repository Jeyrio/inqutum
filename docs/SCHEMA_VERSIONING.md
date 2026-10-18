# Schema versioning

Quittance records carry a `_schemaVersion` field so clients, migration tooling,
and the API itself can distinguish record shapes across releases.

## How it works

Every record returned by the API includes `_schemaVersion` (currently `"1.0"`).
Records persisted before versioning was introduced are treated as version `"0"`
and silently upgraded on read through the compatibility layer.

Schema helpers accept only non-null, non-array records. Invalid runtime values
are rejected with `INVALID_SCHEMA_RECORD`; only an own `_schemaVersion` field
is considered when deciding whether a record is legacy. Stamping returns a new
object and does not mutate the caller's record.

### Read path

```
storage row  -->  transformForRead()  -->  VersionedRecord<StoredInvoice>
                  (fills defaults, stamps current version)
```

- **Legacy records** (no `_schemaVersion`): upgraded via the transform chain in
  `backend/src/schema/compatibility.ts`. Missing fields receive safe defaults
  (`assetCode` -> `"XLM"`, `status` -> `"PENDING"`, `version` -> `1`).
- **Current-version records**: passed through unchanged.
- **Unsupported versions**: throw a structured error with code
  `UNSUPPORTED_SCHEMA_VERSION`.

### Write path

`transformForWrite()` stamps the current schema version on every new record
before persistence. The version is stored alongside the record and echoed in
API responses.

### API responses

`ApiSuccess<T>` accepts an optional `apiVersion` field. When invoice data is
returned, responses may include `apiVersion` so clients can detect the schema
in use.

## Deprecation policy

| Status | Versions | Behaviour |
|---|---|---|
| **Supported** | `1.0` | Read and write as-is. |
| **Deprecated** | `0` | Read-only; upgraded on read. Cannot be written. |
| **Unsupported** | (none yet) | Rejected with `UNSUPPORTED_SCHEMA_VERSION`. |

When a version moves from supported to deprecated, its records remain
readable indefinitely. Once moved to unsupported, reads will fail with a
structured error — this signals that a data migration is required.

## Adding a new schema version

1. Bump `CURRENT_SCHEMA_VERSION` in `backend/src/schema/schema-version.ts`.
2. Add an entry in `UPGRADE_TRANSFORMS` (in `compatibility.ts`) that maps the
   old version to the new one.
3. Move the old version from `supported` to `deprecated` in `DEPRECATION_POLICY`.
4. Add tests for the new transform in `backend/tests/schema-versioning.test.ts`.
5. Update this document.

## Tests

```bash
cd backend
node --import tsx --test tests/schema-versioning.test.ts
```
