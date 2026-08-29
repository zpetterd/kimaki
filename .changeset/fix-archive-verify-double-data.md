---
'kimaki': patch
---

Fixed `kimaki session archive` (and `/archive-thread`) returning
`time.archived not persisted for ...` on every successful archive. The
verify-and-retry check was reading `response.data.data.time.archived` but
the OpenCode SDK only wraps responses once (`response.data`), so the check
always saw `undefined` and reported a false failure.
