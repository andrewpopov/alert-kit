---
kind: added
summary: "Alert suppression: debounce, recovery, escalation and reminder state machine (stepCheck)"
---

Until now every app could SEND an alert but only consumers routing through
deploy-kit's monitor could decide NOT to, so a real-but-known condition
notified on every run — pitelite posted an identical "rouge backup STALE"
message every six hours for days. `stepCheck(prev, result, opts)` is the pure
state machine that decides: `failAfterRuns` debounce before the first alert,
`recoverAfterRuns` before a recovery notice, immediate warn→crit escalation, and
`reAlertAfterMinutes` reminders while a condition persists. It does no I/O and
holds no clock — the caller owns persistence and passes `nowMs` — so a consumer
with a durable outbox and one with a synchronous best-effort sender can share the
same decisions. `unsentAlertState(prev, next)` covers the second kind: persist it
when a send could not be confirmed and the same alert fires again next run,
instead of the state recording a notification that never arrived.

Also exports `redactWebhookUrl`, which existed but was unreachable from the
package entry point, so consumers had to duplicate it to keep a webhook URL out
of their logs.
