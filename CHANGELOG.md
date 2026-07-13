# Changelog

## 0.1.5

- Add `totalTimeoutMs` to bound one delivery across its first attempt, 429
  wait, and retry. A retry that cannot fit within the deadline is not sent.
- Keep an awaited retry timer referenced so a short-lived process does not exit
  before its caller's awaited send settles.
- Add `npm run verify` for the local release gate.
- Upgrade the Vitest development toolchain to a version with no known advisories.

## 0.1.4

Fix (security) — **the webhook URL could leak into a consumer's logs.** A raw fetch
error was rethrown unchanged, and fetch embeds the URL in some of them: a
scheme-less webhook URL yields `TypeError: Failed to parse URL from
discord.com/api/webhooks/<id>/<TOKEN>`. The webhook URL is a BEARER CREDENTIAL,
and callers routinely log `error.message` — bewks does — so the token landed in
application logs.

No raw error escapes the transport now: the URL is redacted from every error
before it is thrown. smarthome and savoro both hand-rolled guards against exactly
this, so the kit was not a superset of the code it replaces. The path had zero
test coverage; it does now.

## 0.1.3

Fix — expose `./package.json` in the `exports` map. Without it,
`require('@andrewpopov/alert-kit/package.json')` threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` — which broke the standards' own documented way of
verifying an INSTALLED version, the guard against the `github:` re-resolve trap.

No runtime change.

## 0.1.2 — 2026-07-12

Correctness fixes to abort/timeout handling and a new aggregate embed-size
guard.

- Fix an aborted (timed-out) 429 body read being swallowed and misread as
  "no `retry_after` found", which fell back to a 1s default delay and made
  `send()` fire a spurious SECOND POST instead of failing with the timeout.
  `readRetryAfterSec` now takes the attempt's `AbortSignal` and rethrows on
  abort instead of swallowing it.
- Fix an aborted (timed-out) non-2xx body read being swallowed into `''` and
  mislabeled as an ordinary HTTP failure (`"...failed with status 500: "`),
  losing the real cause. The abort now propagates out of `attempt()`.
- Both abort paths above, plus a genuine fetch-level abort, now surface the
  same clear, assertable message: `` `Discord webhook POST timed out after
  ${timeoutMs}ms` `` — never a fabricated HTTP status.
- Enforce Discord's separate 6,000-code-point AGGREGATE embed text limit
  (title + description + footer + every field name/value), not just the
  existing per-component caps — 25 max-length fields alone can sum to
  ~32,000 chars and get the whole POST rejected with a 400, losing the
  alert. `buildEmbed` now runs the result through `fitEmbedToBudget`, which
  truncates the description first and, if still over budget, drops fields
  from the end; title and footer are never touched.
- Validate custom `colors`: a value is used only if it's a finite integer in
  `0x000000..0xFFFFFF`; `NaN`, negative, fractional, or out-of-range values
  now fall back to that severity's default color instead of risking a
  Discord 400 (`NaN` previously serialized to JSON `null`).

## 0.1.1 — 2026-07-11

Correctness fixes, no API-shape changes beyond `AlertTransport.isConfigured`
gaining an optional `severity` parameter.

- Bound the response-body read (`res.text()` / 429 `res.clone().json()`), not
  just the `fetch` call — a slow response body could previously hang `send()`
  past `timeoutMs`. `postOnce` is now a single `attempt()` helper whose
  AbortController/timer scope covers the body read too, returning a
  discriminated `{ kind: 'ok' | 'rateLimited' | 'error' }` result.
- Fix `truncate` to cut on code points, not UTF-16 units — an emoji or other
  surrogate pair landing on the truncation boundary no longer leaves a lone
  surrogate in the output.
- Never emit an empty title, field name, or field value — Discord rejects
  those with a 400, which lost the alert entirely. Empty/whitespace-only
  values are replaced with a `—` placeholder before truncation.
- `AlertTransport.isConfigured(severity?)`: best-effort convenience methods
  (`alerter.info/warn/error/critical`) now check the specific severity's
  route so a partially-configured transport (e.g. only a `critical` webhook)
  no longer throws — or silently skips a routed severity — for an unrelated
  severity. Strict `alert()` throws `"not configured"` for a specific
  unrouted severity.
- `onSent` no longer passes the full webhook URL (which embeds a bearer
  token) to the callback. It now passes a non-secret `webhookId` parsed from
  the URL's `.../webhooks/{id}/{token}` shape (`undefined` if the URL
  doesn't match).
- Clamp `retry_after` (header or body) to `[0, 60]` seconds so a negative or
  non-finite value can't produce a negative retry delay; the retry delay
  timer is also `unref()`'d so a pending retry can't keep a short-lived
  process alive.
- Resolve `service`/`username`/`timeoutMs`/`colors` lazily per call, matching
  how routes were already resolved — late `dotenv` population no longer
  silently drops the footer/username.
- Added a real timeout test that drives the actual `setTimeout` → `abort` →
  `AbortSignal` wiring under fake timers, replacing the previous test that
  only injected a pre-made `AbortError`.

## 0.1.0

Initial release. The transport-pluggable alert primitive, with a built-in
Discord transport.

- `AlertTransport` contract (`isConfigured`, `send`) so other transports
  (Slack, PagerDuty, ...) can be added later without touching the `Alerter`
  layer.
- `createDiscordTransport(options)`: posts rich embeds to a Discord incoming
  webhook. Per-severity routing (`severityWebhookUrls` /
  `DISCORD_WEBHOOK_URL_INFO|_WARN|_ERROR|_CRITICAL`) falling back to a primary
  webhook (`webhookUrl` / `DISCORD_WEBHOOK_URL`). Default per-severity embed
  colors, overridable. Truncates title/description/field name/value and caps
  fields at 25 to stay under Discord's limits instead of dropping the alert to
  a 400. Always-bounded request timeout (`timeoutMs`, default 10s) via
  `AbortController`. Retries once on HTTP 429, honoring `retry_after`. Throws
  with the HTTP status and a response snippet on a non-2xx. `fetchImpl` test
  seam.
- `createAlerter(transport, options)` → `{ isConfigured, alert,
  alertBestEffort, info, warn, error, critical }`. `alert` throws when
  unconfigured or on transport failure; `alertBestEffort` (and the
  `info`/`warn`/`error`/`critical` convenience wrappers) return
  `{ sent: false }` without throwing when unconfigured, but still throw on a
  genuine transport failure — the same graceful-degradation shape as
  mailer-kit's `sendMailBestEffort`.
