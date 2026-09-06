---
'kimaki': minor
---

`/archive-thread` now offers a one-click option to also delete the thread's git worktree. When the worktree branch is merged into the project's default branch and has no uncommitted changes, the slash command replies with `Archive + clean up worktree` and `Archive only` buttons. The cleanup path removes the worktree directory and its branch via `git worktree remove` (legacy) or the OpenCode SDK `experimental.workspace.remove` (modern workspaces), then archives the thread. Previously, archiving left the worktree on disk forever, filling up `~/.kimaki/worktrees/` with stale branches.
