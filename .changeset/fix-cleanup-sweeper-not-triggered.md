---
'kimaki': patch
---

Fix the session cleanup reminder sweeper never running. `startThreadCleanupSweeper()` was defined but never called at bot startup, so the 24-hour sweep interval and the initial 60-second sweep were never scheduled. The sweeper is now wired up alongside the other periodic jobs (`startHeapMonitor`, `startTaskRunner`, `startRuntimeIdleSweeper`) and properly shut down on SIGTERM/SIGINT.
