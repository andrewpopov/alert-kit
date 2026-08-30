---
kind: fixed
summary: the aggregate verification gate now rejects stale committed build output
---

`npm run verify` now invokes the existing `verify:dist-fresh` guard, so the
pre-push gate cannot build a fresh local `dist/` while pushing an older
committed artifact.
