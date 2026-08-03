---
'kimaki': patch
---

Fix "Directory does not exist" errors when starting a new worktree session. After `recoverWorktreeDirectory` migrates a worktree from the old `~/.local/share/opencode/worktree/...` path to the new managed `~/.kimaki/worktrees/...` path, the runtime now uses the migrated directory instead of the stale `sdkDirectory` it was constructed with.
