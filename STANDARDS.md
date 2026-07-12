# Shared Package Standards

> **Canonical source:** `agent_brain/knowledge/shared-package-standards.md`.
> This file is a synced copy; change the canonical doc first.

This is a **TypeScript package**: source in `src/`, compiled with `tsc` to a
**committed** `dist/`. `main`/`types` point at `dist/`; the type gate is
`typecheck` + `build` + a dist-freshness check in CI. Zero runtime dependencies;
the browser `fetch` is the only ambient requirement.

Distribution, versioning, branch protection, CI, and the release checklist follow
the canonical standard. Engineering standards that apply here:

1. **Superset of every consumer's copy.** This package must be at least as
   capable as any hand-rolled Discord/alert helper it replaces before that
   consumer is migrated onto it — per-severity routing, truncation, timeout,
   and 429 handling are table stakes, not extras.
2. **Expose the seam consumers need.** Delivery is the one thing that varies
   per consumer (Discord today, Slack/PagerDuty tomorrow); it is the pluggable
   `AlertTransport` interface, not baked into `Alerter`.
3. **Types are a contract, tested.** `verify:pack` installs the tarball and
   resolves every export through both CJS and ESM. Every outbound request is
   bounded by `timeoutMs` — an alert POST must never be able to hang a caller.
4. **Uniform gates:** `test`, `verify:pack`, `typecheck` + `build` + dist freshness.
