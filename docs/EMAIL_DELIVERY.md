# Email delivery

Invoices and proof emails are delivered by the backend, not by a `mailto:` link.
This is the reference for configuring a sending domain, wiring a transport, and
reading delivery results.

Why not `mailto:`: the browser's mail client owns delivery, so the app cannot
tell whether a message was sent, rejected, or silently dropped — a freelancer
could believe "Send invoice" notified a client when nothing was ever delivered.

## 1. Choosing a transport

`backend/src/notifications/email-delivery.ts` exposes a `EmailTransport`
interface with two adapters:

| Adapter | Use when | Dependencies |
| --- | --- | --- |
| `createHttpApiTransport({ endpoint, token, from })` | You use a transactional provider's HTTPS API (Resend, Postmark, SendGrid, Mailgun) | none — plain `fetch` |
| `createSmtpTransport(client)` | You already run an SMTP relay with a nodemailer-compatible client | your existing client |

Until one is constructed, the service uses `disabledTransport`, which fails with
category `config` — a loud, specific error instead of a silent no-op.

## 2. DNS setup required for the sending domain

Deliverability depends on DNS records that live outside this repository. Without
them, mail lands in spam or is rejected outright. Add these for the domain you
send from (e.g. `mail.example.com`):

### SPF — authorise your provider

Declare exactly one SPF record for the sending domain, listing your provider and
nothing else. More than one SPF record is a permanent error.

```dns
mail.example.com.        IN TXT  "v=spf1 include:<provider> -all"
```

Use `-all` (hard fail) once delivery is confirmed. Use `~all` (soft fail) while
still onboarding senders.

### DKIM — sign outgoing mail

Add the selector record your provider gives you:

```dns
<selector>._domainkey.example.com.  IN TXT  "v=DKIM1; k=rsa; p=<public-key>"
```

Publish the same selector in the provider dashboard. Keep the private key only
in the provider (or your secret store) — never in the repository.

### DMARC — tell receivers what to do

Start in monitoring mode, then tighten:

```dns
_dmarc.example.com.  IN TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

After a week of clean reports, move to an enforcing policy:

```dns
_dmarc.example.com.  IN TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; pct=100"
```

Then `p=reject`. Alignment matters: the `From:` domain must match the SPF
`domain:` or DKIM `d=` domain, otherwise alignment fails and the message is
filtered.

### Custom bounce domain (recommended)

Point the provider's bounce handling at a subdomain you control
(`bounce.example.com`) with the provider's DKIM/CNAME records, so SPF/DMARC
policy for the corporate domain is not affected by the mail provider.

## 3. Wiring a transport

```ts
import { EmailDeliveryService, createHttpApiTransport } from './notifications/email-delivery';

const transport = createHttpApiTransport({
  endpoint: 'https://api.<provider>.com/v1/messages',
  token: process.env.EMAIL_API_TOKEN!,   // secret store, never committed
  from: 'Quittance <billing@mail.example.com>',
});

export const emailService = new EmailDeliveryService({
  transport,
  maxAttempts: 3,     // transient/quota failures are retried with backoff
  retryDelayMs: 250,
});
```

## 4. What the freelancer sees

`POST /api/email/send` always answers with an explicit outcome — never a bare 2xx
that could be mistaken for delivery:

**Accepted**

```json
{
  "success": true,
  "data": { "status": "sent", "deliveryId": "…", "providerMessageId": "prov_123" }
}
```

**Rejected** — the code tells the UI exactly what to say:

| Category | HTTP | Code | What to show |
| --- | --- | --- | --- |
| `auth` | 502 | `EMAIL_AUTH_FAILED` | Provider rejected our credentials — maintainer action |
| `quota` | 429 | `EMAIL_QUOTA_EXCEEDED` | Rate limited / out of quota — retry later |
| `transient` | 503 | `EMAIL_TRANSIENT_FAILURE` | Temporarily unreachable — retry |
| `invalid_recipient` | 400 | `EMAIL_INVALID_RECIPIENT` | Check the address |
| `config` | 503 | `EMAIL_NOT_CONFIGURED` | Delivery not set up for this deployment |
| `permanent` | 502 | `EMAIL_FAILED` | Provider rejected the message |

Each response includes `recoveryAction` so the frontend can render specific
guidance rather than a generic failure toast.

## 5. Bounces and complaints

Provider callbacks are ingested rather than ignored:

```bash
curl -X POST https://<api>/api/email/webhook \
  -H 'content-type: application/json' \
  -d '{"messageId":"prov_123","event":"bounce","reason":"mailbox full"}'
```

`event` is one of `bounce`, `complaint`, `delivered`. A bounce moves the
original delivery to `status: "bounced"` and a complaint to `"complained"`, both
keyed by the provider message id from the original send.

Operational visibility:

- `GET /api/email/deliveries?to=&status=&limit=` — full delivery log
- `GET /api/email/problems` — everything **not** confirmed as sent (failed,
  bounced, complained), i.e. the manual follow-up list

## 6. Operational notes

- **Auth errors are never retried.** A bad credential will not fix itself, and
  retrying risks the provider locking the account.
- **Quota errors are retried**, bounded by `maxAttempts`, with linear backoff.
- **Idempotency.** Pass `idempotencyKey` (the invoice route defaults to
  `invoice:<id>`) so a retried request cannot send a second copy.
- **Secrets.** `EMAIL_API_TOKEN` / SMTP credentials belong in the deployment's
  secret store. Never commit them, and never log message bodies.

Related: [`docs/NOTIFICATIONS.md`](NOTIFICATIONS.md) ·
[`docs/RUNBOOK.md`](RUNBOOK.md) · [`docs/SECURITY.md`](SECURITY.md)
