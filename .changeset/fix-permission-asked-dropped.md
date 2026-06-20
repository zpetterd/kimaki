---
'kimaki': patch
---

Fix `permission.asked` and other interactive events being silently dropped when the runtime has no active `sessionId` (e.g. during session recovery after bot restart).
