---
kind: added
summary: Add createFallbackTransport, composing transports (e.g. DM primary + webhook fallback) so an alert isn't silently dropped
---

`createFallbackTransport(transports, options?)` composes any number of
`AlertTransport`s into one: it skips a child unconfigured for the alert's
severity, tries the rest in order, and stops at the first that delivers —
so, for example, a Discord bot DM (which has strictly more failure modes
than a webhook: bot not in a mutual guild, DMs closed, token rotation,
rate limits) can fall back to a webhook instead of dropping the alert.
`isConfigured(severity?)` is true if ANY child is configured. If every
configured child fails, it throws `AggregateAlertDeliveryError` with the
sanitized outcome of every child tried — never just the last one — so a
terminal failure from one route can't hide a retryable failure from
another; `retryable` is true if any attempted route could succeed on a
retry. The winning delivery's receipt gains two new, additive
`AlertDeliveryReceipt` fields: `route` (the winning child's label or
index) and `attemptedRoutes` (sanitized outcomes for every child skipped
or failed before it). An optional `onDegraded` callback is invoked
whenever delivery didn't succeed via the first configured route,
including on total failure; like the existing `onSent`/`onSkipped`
callbacks, a throwing or slow observer is contained and can never fail an
alert that actually succeeded.
