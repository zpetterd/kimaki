---
'kimaki': patch
---

`archiveOpenCodeSession` verify-and-retry no longer reads a phantom double-wrapped
SDK response. The cast to `{ data: { data: Session } }` was wrong — the SDK wraps
parsed bodies once (`{ data: <body> }`), so `data.data` was always undefined and
`time.archived` was always read as undefined, causing the verify step to report a
failed archive even when `PATCH /session/{id}` correctly persisted. A
shape-tolerant helper now handles both `responseStyle: "fields"` and
`responseStyle: "data"` without needing to know which the client is configured with.
