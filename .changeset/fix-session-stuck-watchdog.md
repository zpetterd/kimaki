---
'kimaki': patch
---

Fix sessions getting permanently stuck in "busy" state when the model API or tools hang without OpenCode emitting proper idle/error events. A watchdog now detects sessions that have been busy with no event activity for 5+ minutes and automatically resets them so the user can continue.
