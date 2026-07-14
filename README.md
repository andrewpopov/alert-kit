# @andrewpopov/alert-kit

The **transport-pluggable alert primitive** for the fleet. A small contract
(`AlertTransport`: `isConfigured` + `send`) plus one built-in transport —
Discord, via incoming webhooks — so apps can fire `info`/`warn`/`error`/
`critical` alerts without hand-rolling embed formatting, per-severity
routing, or 429 backoff each time.

## Discord transport

Rich embeds posted to a Discord incoming webhook, with per-severity routing:

```
DISCORD_WEBHOOK_URL             primary route (fallback for any severity)
DISCORD_WEBHOOK_URL_INFO        override for info alerts
DISCORD_WEBHOOK_URL_WARN        override for warn alerts
DISCORD_WEBHOOK_URL_ERROR       override for error alerts
DISCORD_WEBHOOK_URL_CRITICAL    override for critical alerts
DISCORD_ALERT_WEBHOOK           fleet-wide default, used when nothing above resolves
DISCORD_ALERT_SERVICE           embed footer text (e.g. "cairn-prod")
DISCORD_ALERT_USERNAME          webhook display name
```

An alert's route is `severityWebhookUrls[severity] ?? webhookUrl` (env
equivalents apply the same way), falling back to `env.DISCORD_ALERT_WEBHOOK`
— the fleet-wide default alert channel — only once BOTH of those are
exhausted for that severity. An explicitly-provided URL (an argument/option,
or the existing per-app `DISCORD_WEBHOOK_URL*` env vars) always wins over the
fleet default; the fleet default is the *last* resort, not a first choice.
This makes the fleet Discord channel the default alert destination with zero
per-consumer config — a new app that sets nothing still gets alerts, and an
app with its own webhook is unaffected. If nothing resolves at all, that
severity has no route — `isConfigured()` still reports true if *any* route
(including the fleet default) exists, but `send()` throws for the unrouted
severity, same as before.

Discord's embed limits are enforced by **truncating**, never by dropping the
alert or letting a request 400: title ≤ 256 chars, description ≤ 4096, field
name ≤ 256, field value ≤ 1024, footer ≤ 2048, max 25 fields — each truncated
with a trailing `…`. Every request is bounded by `timeoutMs` (default 10s). A
`429` is retried once, honoring `retry_after`/`Retry-After` (capped at 60s).
Set `totalTimeoutMs` to bound the initial POST, retry wait, and retry as one
delivery deadline; a retry that cannot fit fails without issuing a second POST.

### Destination-URL guard rail

Every consumer today passes a trusted, env-sourced webhook URL, so there's no
built-in SSRF check — nothing stops a *future* consumer from passing a
user-supplied URL instead. Pass `validateUrl(url)` to opt in: it runs against
the resolved destination URL immediately before every POST, and a thrown (or
rejected) error blocks the send. Default behavior is unchanged when omitted.
This is a guard rail, not a full SSRF stack — compose it with something like
`@andrewpopov/url-guard`'s `assertSafeUrl`:

```ts
import { assertSafeUrl } from '@andrewpopov/url-guard';

const transport = createDiscordTransport({
  webhookUrl: userSuppliedUrl,
  validateUrl: (url) => assertSafeUrl(url),
});
```

## Install

```
npm install github:andrewpopov/alert-kit#v0.3.0
```

## Use

```ts
import { createDiscordTransport, createAlerter } from '@andrewpopov/alert-kit';

const transport = createDiscordTransport({
  service: 'cairn-prod',
  severityWebhookUrls: { critical: process.env.DISCORD_WEBHOOK_URL_ONCALL },
  onSent: ({ severity, title }) => logger.info('alert sent', { severity, title }),
});
const alerter = createAlerter(transport);

// Best-effort: no-ops with { sent: false } when unconfigured, so app flows
// can call unconditionally. Still throws on a genuine transport failure.
await alerter.error('Payment webhook failed', {
  message: 'Stripe returned a 500 for charge ch_123',
  fields: { chargeId: 'ch_123', attempt: 3 },
});

// Strict: throws if unconfigured or the webhook POST fails.
await alerter.alert({ severity: 'critical', title: 'DB connection pool exhausted' });
```

## API

| Export | Purpose |
|---|---|
| `createDiscordTransport(options)` | Build a Discord `AlertTransport`. |
| `createAlerter(transport, options?)` | Build an `Alerter` bound to a transport. |
| `alerter.alert(a)` | Send; **throws** if unconfigured or on transport failure. |
| `alerter.alertBestEffort(a)` | Send if configured, else `{ sent: false }` (no throw). |
| `alerter.info/warn/error/critical(title, opts?)` | Best-effort convenience wrappers. |
| `alerter.isConfigured()` | Whether the bound transport has any route configured. |

`Alert`: `{ severity, title, message?, fields?, service?, timestamp? }`.
`DiscordTransportOptions`: `env`, `webhookUrl`, `severityWebhookUrls`,
`service`, `username`, `timeoutMs`, `colors`, `retryOn429`, `fetchImpl`,
`totalTimeoutMs`, `onSent`, `onSkipped`, `validateUrl`.

## Verify locally

```bash
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

### The transport seam

`AlertTransport` is `{ isConfigured(), send(alert) }`. `send` MUST throw on
any failure to deliver — including "no route for this severity" — so
`Alerter` can decide strict-vs-best-effort in one place regardless of which
transport is plugged in. Inject a fake `AlertTransport` (or a fake
`fetchImpl` into `createDiscordTransport`) in tests; never hit the network.

## Standards

See [`STANDARDS.md`](./STANDARDS.md) (synced from `agent_brain/knowledge/shared-package-standards.md`).

## Project policies

See [Contributing](./CONTRIBUTING.md), [Support](./SUPPORT.md), and the
[Security Policy](./SECURITY.md). This package is licensed under [MIT](./LICENSE).
