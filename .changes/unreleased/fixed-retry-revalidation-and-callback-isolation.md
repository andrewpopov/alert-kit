---
kind: fixed
summary: validateUrl now revalidates every retry POST, and a throwing onSent/onSkipped can no longer turn a completed delivery or a no-op skip into a failure
---

Three gaps found by a completeness audit, all in the same shape: documented
behavior the code didn't actually deliver. `validateUrl` was documented as
running "immediately before every POST" but only ran once, before the initial
attempt — the 429 retry issued its second POST with no revalidation at all,
which defeats the whole point of the guard rail for a consumer relying on it
for SSRF protection against a redirect or a mutated route between attempts.
It now runs before each attempt, including the retry, and a validation
failure on the retry surfaces exactly the way a first-attempt failure does.
Separately, `onSent` fired after Discord had already accepted the POST but
before `deliver()`/`send()` returned, so a throwing `onSent` turned a
genuinely successful delivery into a rejection — the caller lost the true
receipt and was encouraged to retry, risking a duplicate alert. `onSkipped`
had the same problem on the unconfigured best-effort path, where the docs
promise `{ sent: false }` "WITHOUT throwing." Both callbacks are now
contained: a thrown/rejected callback is caught and logged via
`console.error` (redacted, in `onSent`'s case) rather than propagated, so a
completed delivery and a no-op skip report their true outcome regardless of
what the host callback does.
