# Contributor Local Health Diagnostics

Inqutum provides a single unified diagnostics command for contributors to verify their local setup, dependencies, environment configuration, database readiness, and network mocks before starting development.

## Running Diagnostics

Run the diagnostics check from either the project root or the `backend` directory:

```bash
# From backend directory
npm run diagnostics

# Or directly using tsx from project root
npx tsx scripts/diagnostics.ts

# Also probe Horizon over the network (opt-in)
npm run diagnostics -- --network
```

The exit code is `1` when any check is `FAIL`, and `0` otherwise, warnings included.

## What it Checks

1. **Node.js Runtime**: Verifies that your installed Node.js engine satisfies `>= 18.0.0`.
2. **Project Fixtures & Paths**: Ensures required core modules, tests, and frontend paths exist.
3. **Environment Configuration**: Validates active environment variables against the typed schema, flags unsafe combinations (e.g. simulation enabled in production), and checks required origins.
4. **Storage Layer State**: Detects whether persistent PostgreSQL or zero-dependency in-memory MVP mode is active.
5. **Stellar Horizon Gateway**: Confirms correct network endpoints (Testnet vs Public) and HTTPS protocol usage.
6. **Dependencies (backend, frontend)**: Reads each workspace's `package.json`, `package-lock.json` and installed `node_modules/*/package.json` without running npm.
   - `FAIL`: the lockfile is missing, or its root entry disagrees with `package.json`. `npm ci` refuses both states. Fix by running `npm install` in that workspace and committing the lockfile.
   - `WARN`: the lockfile is in sync, but packages are not installed, or are installed at a version other than the lockfile's (stale after a pull). Fix with `npm ci`, which is safe to re-run.
7. **Admin Authorization Secrets**: `JOBS_ADMIN_TOKEN` guards `/api/jobs` and `/api/ops/*`. `MAINTAINER_INTENT_SECRET` enables high-impact intents. Flags secrets shorter than 16 characters. A short `MAINTAINER_INTENT_SECRET` silently leaves approvals disabled. Also flags an intent secret set without the admin token, which leaves the intent routes unreachable. This is `WARN` in development and `FAIL` when `NODE_ENV=production`. Values are never printed.
8. **Database Seed & Schema Fixtures**: Validates `db/seed.sql` and `db/schema.sql` presence, valid Stellar demo wallet addresses (`G...`), positive amounts, and insert statement structure.
9. **Common Setup & Failure Fixes**: Detects missing local `.env` files, port configuration collisions (e.g. backend `PORT=3000` conflicting with Next.js frontend port `3000`), and uninstalled dependencies.
10. **Stellar Horizon Reachability** (`--network` only): `GET` on the Horizon root, comparing its `network_passphrase` with the passphrase for `STELLAR_NETWORK`: `Test SDF Network ; September 2015` for TESTNET, `Public Global Stellar Network ; September 2015` for PUBLIC ([Stellar networks](https://developers.stellar.org/docs/networks)). A mismatch is `FAIL`, because payments would be verified on the wrong network.

## Automated Fixes (`--fix`)

Contributors can pass `--fix` to automatically and safely remediate common local setup issues:

```bash
npm run diagnostics -- --fix
```

When `--fix` is passed:
- Missing `backend/.env` is safely created from `backend/env.mvp.example`.
- Missing `frontend/.env.local` is safely created from `frontend/env.mvp.local`.
- Non-destructive and safe to re-run. Existing `.env` files are never overwritten.

## Retry, authorization and failure behaviour

The Horizon probe uses `scripts/http-probe.ts`, which is also used by the release gate:

| Response | Handling |
|----------|----------|
| `2xx` with JSON | Checked against the expected passphrase. |
| Network error, timeout (10 s), `429`, `502`, `503`, `504`, or `2xx` that is not JSON | Retried up to 5 attempts with exponential backoff (1 s, 2 s, 4 s, 8 s cap). A `Retry-After` header (delay-seconds or HTTP-date) wins, capped at 8 s. Horizon documents per-IP rate limiting (3600 requests/hour by default), answered with `429 Too Many Requests`. It does not document rate-limit headers, so the probe uses `Retry-After` only when one is present. |
| `401` / `403` | `FAIL`, not retried. The provider needs credentials. |
| Other status | Reported once, not retried. |
| Still unreachable after retries | `WARN` in development, where offline work with `NEXT_PUBLIC_USE_MOCK=true` is still possible. `FAIL` in production. |

Worst case, the probe takes 5 × 10 s plus 15 s of backoff, about 65 s. Without `--network` no request leaves the machine.

## Recovery

| Finding | Action |
|---------|--------|
| Missing `.env` or `.env.local` | Run `npm run diagnostics -- --fix` to auto-populate from templates. |
| Port 3000/3001 collision | Ensure `PORT=3001` in `backend/.env` so it does not conflict with frontend port 3000. |
| Lockfile drift | `cd <workspace> && npm install`, review the diff, commit `package-lock.json`. |
| Missing or stale packages | `cd <workspace> && npm ci`. |
| Horizon passphrase mismatch | Fix `STELLAR_HORIZON_URL` or `STELLAR_NETWORK` in `backend/.env`. Restart the API. |
| Weak admin secrets | `openssl rand -hex 32` for each secret. Restart the API so the new values load. |

## Safety Guarantee

The diagnostics command defaults to strictly **read-only** and performs non-destructive health probes. The `--fix` option only creates missing local development template files and never touches databases or network state.

## Compatibility

`runDiagnostics(env)` keeps its signature. The second argument (`{ network, rootDir, probe, fix }`) is optional. Existing consumers that switch on known categories are unaffected.
