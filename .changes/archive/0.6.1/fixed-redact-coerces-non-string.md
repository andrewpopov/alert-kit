---
kind: fixed
summary: redactWebhookUrl coerces non-string input instead of throwing
---

`redactWebhookUrl` threw a `TypeError` on anything that wasn't a string. Every
real call site is a catch block doing `redactWebhookUrl(err.message ?? err, url)`,
and a thrown non-Error, a rejected `undefined`, or a numeric exit status all
arrive as non-strings — so the helper threw from inside the error handler of the
alert that was reporting the original failure. It now coerces, and its parameter
type widened from `string` to `unknown` (a widening, so existing callers are
unaffected). Found when db-backup went to delete its own copy: that copy had
coerced from the start, and adopting the kit's version as-is would have broken
`notifyAlert`'s documented never-throws contract.
