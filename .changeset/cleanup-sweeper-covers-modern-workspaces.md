---
'kimaki': minor
---

The daily thread cleanup sweeper now also evaluates modern SDK workspaces (the `thread_workspaces` table) in addition to legacy `thread_worktrees` rows. Threads whose workspace branch is merged into the default branch and has no uncommitted changes get a daily prompt with "Clean up worktree & archive" / "Dismiss" buttons. On confirm, the sweeper routes through the OpenCode SDK `experimental.workspace.remove` for modern workspaces (deleting the branch too) or `git worktree remove` for legacy rows, then archives the thread. Previously the sweeper only saw legacy `thread_worktrees` and silently skipped modern workspaces, leaving their directories to accumulate in `~/.kimaki/worktrees/`.

`kimaki session archive --cleanup-worktree` adds an opt-in flag that does the same cleanup non-interactively — refuses with a clear error if the branch isn't merged or the worktree is dirty, so it never silently destroys unmerged work.
