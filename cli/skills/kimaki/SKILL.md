---
name: kimaki
description: >
  Kimaki is a Discord-based AI development environment. When running in Kimaki,
  you are operating within a Discord thread with access to Discord-specific tools,
  kimaki CLI commands, and the kimaki monorepo architecture.
version: 1.0.0
---

# Kimaki Discord Environment

You are running in **Kimaki** — a Discord-based AI development environment.

## Permissions

Only users with these Discord permissions can send messages to the bot:
- Server Owner
- Administrator permission
- Manage Server permission
- "Kimaki" role (case-insensitive)

Other Discord bots are ignored by default. To allow another bot to trigger sessions (for multi-agent orchestration), assign it the "Kimaki" role.

## CLI Commands

All kimaki CLI commands can be run from anywhere in the repo. These are the primary way to interact with kimaki.

### Upgrading kimaki

Use built-in upgrade commands when user explicitly asks to update kimaki:

- Discord slash command: `/upgrade-and-restart` upgrades to latest version and restarts bot
- CLI command: `kimaki upgrade` upgrades and restarts bot (or starts a fresh process if needed)
- CLI command: `kimaki upgrade --skip-restart` upgrades without restarting

**Do not restart the bot unless user explicitly asks for it.**

### Debugging kimaki issues

If there are internal kimaki issues (sessions not responding, bot errors, unexpected behavior), read the log file at `${getDataDir()}/kimaki.log`. This file contains detailed logs of all bot activity including session creation, event handling, errors, and API calls. The log file is reset every time the bot restarts, so it only contains logs from the current run.

### Uploading files to Discord

To upload files to Discord thread (images, screenshots, long files that would clutter chat), run:

```bash
kimaki upload-to-discord --session ${sessionId} <file1> [file2] ...
```

### Requesting files from user

To ask user to upload files from their device, use `kimaki_file_upload` tool. This shows a native file picker dialog in Discord. The files are downloaded to the project's `uploads/` directory and the tool returns the local file paths.

### Archiving current thread

To archive the current Discord thread (hide it from sidebar) and stop the session, run:

```bash
kimaki session archive --session ${sessionId}
```

**Only do this when the user explicitly asks to close or archive the thread, and only after your final message.**

### Searching Discord users

To search for Discord users in a guild (needed for mentions like <@userId>), run:

```bash
kimaki user list --guild ${guildId || '<guildId>'} --query "username"
```

This returns user IDs you can use for Discord mentions.

### Starting new sessions from CLI

To start a new thread/session in this channel programmatically, run:

```bash
kimaki send --channel ${channelId} --prompt "your prompt here" --user ${userArg}
```

You can use this to "spawn" parallel helper sessions like teammates: start new threads with focused prompts, then come back and collect the results.

**IMPORTANT: NEVER use `--worktree` unless the user explicitly asks for a worktree.** Default to creating normal threads without worktrees.

To send a prompt to an existing thread instead of creating a new one:

```bash
kimaki send --thread <thread_id> --prompt "follow-up prompt"
```

Use this when you already have the Discord thread ID.

To send to the thread associated with a known session:

```bash
kimaki send --session <session_id> --prompt "follow-up prompt"
```

Use this when you have the OpenCode session ID.

Use `--notify-only` to create a notification thread without starting an AI session:

```bash
kimaki send --channel ${channelId} --prompt "User cancelled subscription" --notify-only${userArg}
```

Use `--user` to add a specific Discord user to the new thread:

```bash
kimaki send --channel ${channelId} --prompt "Review the latest CI failure"${userArg}
```

Use `--worktree` to create a git worktree for the session (ONLY when the user explicitly asks for a worktree):

```bash
kimaki send --channel ${channelId} --prompt "Add dark mode support" --worktree dark-mode${userArg}
```

Use `--cwd` to start a session in an existing git worktree directory (must be a worktree of the project):

```bash
kimaki send --channel ${channelId} --prompt "Continue work on feature" --cwd /path/to/existing-worktree${userArg}
```

**Important:**
- NEVER use `--worktree` unless the user explicitly requests a worktree. Most tasks should use normal threads without worktrees.
- Use `--cwd` to reuse an existing worktree directory. Use `--worktree` to create a new one.
- The prompt passed to `--worktree` is the task for the new thread running inside that worktree.
- Do NOT tell that prompt to "create a new worktree" again, or it can create recursive worktree threads.
- Ask the new session to operate on its current checkout only (e.g. "validate current worktree", "run checks in this repo").

Use `--agent` to specify which agent to use for the session:

```bash
kimaki send --channel ${channelId} --prompt "Plan the refactor of the auth module" --agent plan${userArg}
```

### Running opencode commands via kimaki send

You can trigger registered opencode commands (slash commands, skills, MCP prompts) by starting `--prompt` with `/commandname`:

```bash
kimaki send --thread <thread_id> --prompt "/review fix the auth module"
kimaki send --channel ${channelId} --prompt "/build-cmd update dependencies"${userArg}
```

The command name must match a registered opencode command. If the command is not recognized, the prompt is sent as plain text to the model. This works for both new threads (`--channel`) and existing threads (`--thread`/`--session`).

### Switching agents in the current session

The user can switch the active agent mid-session using the Discord slash command `/<agentname>-agent`. For example if you are in plan mode and the user asks you to edit files, tell them to run `/build-agent` to switch to the build agent first.

You can also switch agents via `kimaki send`:

```bash
kimaki send --thread <thread_id> --prompt "/<agentname>-agent"
```

### Scheduled sends and task management

Use `--send-at` to schedule a one-time or recurring task:

```bash
kimaki send --channel ${channelId} --prompt "Reminder: review open PRs" --send-at "2026-03-01T09:00:00Z"${userArg}
kimaki send --channel ${channelId} --prompt "Run weekly test suite and summarize failures" --send-at "0 9 * * 1"${userArg}
```

**ALL scheduling is in UTC.** Dates must be UTC ISO format ending with `Z`. Cron expressions also fire in UTC (e.g. `0 9 * * 1` means 9:00 UTC every Monday).

When the user specifies a time without a timezone, ask them to confirm their timezone or the UTC equivalent. Never guess the user's timezone.

`--send-at` supports the same useful options for new threads:
- `--notify-only` to create a reminder thread without auto-starting a session
- `--worktree` to create the scheduled thread as a worktree session (only if the user explicitly asks for a worktree)
- `--agent` and `--model` to control scheduled session behavior
- `--user` to add a specific user to the scheduled thread

`--wait` is incompatible with `--send-at` because scheduled tasks run in the future.

For scheduled tasks, use long and detailed prompts with goal, constraints, expected output format, and explicit completion criteria.

**Notification prompts must be very detailed.** The user receiving the notification has no context of the original session. Include: what was done, when it was done, why the reminder exists, what action is needed, and any relevant identifiers (key names, service names, file paths, URLs). A vague "your API key is expiring" is useless — instead say exactly which key, which service, when it was created, when it expires, and how to renew it.

**Notification strategy for scheduled tasks:**
- Prefer selective mentions in the prompt instead of relying on broad thread notifications.
- If a task needs user attention, include this instruction in the prompt: "mention @username when task requires user review or notification".
- Replace `@username` with the relevant user from the current thread context.
- Without `--user`, there is no guaranteed direct user mention path; task output should mention users only when relevant.
- With `--user`, the user is added to the thread and may receive more frequent thread-level notifications.

Manage scheduled tasks with:

```bash
kimaki task list
kimaki task edit <id> --prompt "new prompt" [--send-at "new schedule"]
kimaki task delete <id>
```

`kimaki session list` also shows if a session was started by a scheduled `delay` or `cron` task, including task ID when available.

**Use case patterns:**
- Reminder flows: create deadline reminders in this channel with one-time `--send-at`; mention only if action is required.
- Proactive reminders: when you encounter time-sensitive information during your work (e.g. creating an API key that expires in 90 days, a certificate with an expiration date, a trial period ending, a deadline mentioned in code comments), proactively schedule a `--notify-only` reminder before the expiration so the user gets notified in time. For example, if you generate an API key expiring on 2026-06-01, schedule a reminder a few days before: `kimaki send --channel ${channelId} --prompt "Reminder: <@USER_ID> the API key created on 2026-03-01 expires on 2026-06-01. Renew it before it breaks production." --send-at "2026-05-28T09:00:00Z" --notify-only`. Always tell the user you scheduled the reminder so they know.
- Weekly QA: schedule "run full test suite, inspect failures, post summary, and mention @username only when failures require review".
- Weekly benchmark automation: schedule a benchmark prompt that runs model evals, writes JSON outputs in the repo, commits results, and mentions only for regressions.
- Recurring maintenance: use cron `--send-at` for repetitive tasks like rotating secrets, checking dependency updates, running security audits, or cleaning up stale branches. Example: `--send-at "0 9 1 * *"` to run on the 1st of every month.
- Thread reminders: when the user says "remind me about this in 2 hours" (or any duration), use `--send-at` with `--thread` to resurface the current thread. Compute the future UTC time and send a mention so Discord shows a notification:

```bash
kimaki send --session ${sessionId} --prompt "Reminder: <@USER_ID> you asked to be reminded about this thread." --send-at "<future_UTC_time>" --notify-only
```

Replace `<future_UTC_time>` with the computed UTC ISO timestamp. The `--notify-only` flag creates just a notification message without starting a new AI session. The `<@userId>` mention ensures the user gets a Discord notification.

**Scheduled tasks can maintain project memory** by reading and updating an md file in the repository (for example `docs/automation-notes.md`) on each run.

**Worktrees are useful for handing off parallel tasks** that need to be isolated from each other (each session works on its own branch).

### Creating worktrees

ONLY create worktrees when the user explicitly asks for one. Never proactively use `--worktree` for normal tasks.

When the user asks to "create a worktree" or "make a worktree", they mean you should use the kimaki CLI to create it. Do NOT use raw `git worktree add` commands. Instead use:

```bash
kimaki send --channel ${channelId} --prompt "your task description" --worktree worktree-name${userArg}
```

This creates a new Discord thread with an isolated git worktree and starts a session in it. The worktree name should be kebab-case and descriptive of the task.

By default, worktrees are created from `HEAD`, which means whatever commit or branch the current checkout is on. If you want a different base, pass `--base-branch` or use the slash command option explicitly.

**Critical recursion guard:**
- If you already are in a worktree thread, do not create another worktree unless the user explicitly asks for a nested worktree.
- In worktree threads, default to running commands in the current worktree and avoid `kimaki send --worktree`.

### Sending sessions to existing worktrees

Use `--cwd` to start a session in an existing git worktree directory instead of creating a new one:

```bash
kimaki send --channel ${channelId} --prompt "Continue work on feature X" --cwd /path/to/existing-worktree${userArg}
```

The path must be a git worktree of the project (validated via `git worktree list`). The session resolves to the correct project channel but uses the worktree as its working directory. Use `--worktree` to create a new worktree, `--cwd` to reuse an existing one.

**Important:** When using `kimaki send`, prefer combining investigation and action into a single session instead of splitting them. The new session has no memory of this conversation, so include all relevant details. Use **bold**, `code`, lists, and > quotes for readability.

This is useful for automation (cron jobs, GitHub webhooks, n8n, etc.)

### Session handoff

When you are approaching the **context window limit** or the user explicitly asks to **handoff to a new thread**, use the `kimaki send` command to start a fresh session with context:

```bash
kimaki send --channel ${channelId} --prompt "Continuing from previous session: <summary of current task and state>"${userArg}
```

The command automatically handles long prompts (over 2000 chars) by sending them as file attachments.

Use this for handoff when:
- User asks to "handoff", "continue in new thread", or "start fresh session"
- You detect you're running low on context window space
- A complex task would benefit from a clean slate with summarized context

### Reading other sessions

To list all sessions in this project (shows which were started via kimaki):

```bash
kimaki session list
kimaki session list --json  # machine-readable output
kimaki session list --project /path/to/project  # specific project
```

To search past sessions for this project (supports plain text or /regex/flags):

```bash
kimaki session search "auth timeout"
kimaki session search "/error\\s+42/i"
kimaki session search "rate limit" --project /path/to/project
kimaki session search "/panic|crash/i" --channel <channel_id>
```

To read a session's full conversation as markdown, pipe to a file and grep it to avoid wasting context. Logs go to stderr, so redirect stderr to hide them:

```bash
kimaki session read <sessionId> > ./tmp/session.md 2>/dev/null
```

Then use grep/read tools on the file to find what you need.

### Cross-project commands

When the user references another project by name, run `kimaki project list` to find its directory path and channel ID. Then read files, search code, or run commands directly in that directory. If the project is not listed, use `kimaki project add /path/to/repo` to register it and create a Discord channel for it. Do not add subfolders of an existing project — only add root project directories.

```bash
# List all registered projects with their channel IDs
kimaki project list
kimaki project list --json  # machine-readable output

# Create a new project in ~/.kimaki/projects/<name> (folder + git init + Discord channel)
kimaki project create my-new-app

# Add an existing directory as a project
kimaki project add /path/to/repo
```

To send a task to another project:

```bash
# Send to a specific channel
kimaki send --channel <channel_id> --prompt "Plan how to update the API client to v2"

# Or use --project to resolve from directory
kimaki send --project /path/to/other-repo --prompt "Plan how to bump version to 1.2.0"
```

When sending prompts to other projects, always ask the agent to plan first, never build upfront. The prompt should start with "Plan how to ..." so the user can review before greenlighting implementation.

**Use cases:**
- **Updating a fork or dependency** the user maintains locally
- **Coordinating changes** across related repos (e.g., SDK + docs)
- **Delegating subtasks** to isolated sessions in other projects

### Waiting for a session to finish

Use `--wait` to block until a session completes and print its full conversation to stdout. This is useful when you need the result of another session before continuing your work.

**IMPORTANT: if you run `kimaki send --wait` via the Bash tool, you must set the Bash tool `timeout` to **20 minutes or more**
(example: `timeout: 1_500_000`). Otherwise the tool will terminate early (default is 2 minutes) and you won't see long sessions.

If your Bash tool timeout triggers anyway, fall back to reading the session output from disk:

```bash
kimaki session read <sessionId> > ./tmp/session.md 2>/dev/null
```

```bash
# Start a session and wait for it to finish
kimaki send --channel <channel_id> --prompt "Fix the auth bug" --wait

# Send to an existing thread and wait
kimaki send --thread <thread_id> --prompt "Run the tests" --wait
```

The command exits with the session markdown on stdout once the model finishes responding.

Use `--wait` when you need to:
- **Fix a bug in another project** before continuing here (e.g., fix a dependency, then resume)
- **Run a task in a separate worktree** and use the result in your current session
- **Chain sessions sequentially** where the next depends on the previous output

## Running dev servers with tunnel access

ALWAYS use `kimaki tunnel` when starting any dev server. NEVER run `pnpm dev`, `npm run dev`, or any dev server command without wrapping it in `kimaki tunnel`. Always invoke Kimaki directly as `kimaki`, never via `npx` or `bunx`. The user is on Discord, not at the terminal — localhost URLs are useless to them. They need a tunnel URL to access the site.

Use `tmux` to run the tunnel + dev server combo in the background so it persists across commands.

### Installing tmux (if missing)

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux
```

### Starting a dev server with tunnel

Use a tmux session with a descriptive name like `projectname-dev` so you can reuse it later:

Use random tunnel IDs by default. Only pass `-t` when exposing a service that is safe to be publicly discoverable.

```bash
# Create a tmux session (use project name + dev, e.g. "myapp-dev", "website-dev")
tmux new-session -d -s myapp-dev

# Run the dev server with kimaki tunnel inside the session
tmux send-keys -t myapp-dev "kimaki tunnel -p 3000 -- pnpm dev" Enter
```

### Getting the tunnel URL

```bash
# View session output to find the tunnel URL
tmux capture-pane -t myapp-dev -p | grep -i "tunnel"
```

### Examples

```bash
# Next.js project
tmux new-session -d -s projectname-nextjs-dev-3000
tmux send-keys -t nextjs-dev "kimaki tunnel -p 3000 -- pnpm dev" Enter

# Vite project on port 5173
tmux new-session -d -s vite-dev-5173
tmux send-keys -t vite-dev "kimaki tunnel -p 5173 -- pnpm dev" Enter

# Custom tunnel ID (only for intentionally public-safe services)
tmux new-session -d -s holocron-dev
tmux send-keys -t holocron-dev "kimaki tunnel -p 3000 -t holocron -- pnpm dev" Enter
```

### Stopping the dev server

```bash
# Send Ctrl+C to stop the process
tmux send-keys -t myapp-dev C-c

# Or kill the entire session
tmux kill-session -t myapp-dev
```

### Listing sessions

```bash
tmux list-sessions
```
