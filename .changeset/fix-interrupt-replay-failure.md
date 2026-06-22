---
'kimaki': patch
---

Fix queued user messages being silently dropped when promptAsync fails after session.abort() in the interrupt plugin. The plugin now waits an additional 2 seconds if the session is still busy after the abort timeout, and handles promptAsync failures gracefully by logging the error and continuing to drain the next queued message instead of silently dropping the user's message.
