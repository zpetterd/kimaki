---
'kimaki': patch
---

`kimaki session archive` (and `/archive-thread`) now re-fetches the session after
calling `session.update` to verify `time.archived` was persisted, retrying once before
returning an error. Prevents silent failures where the OpenCode server accepts the
request without committing the archive state.
