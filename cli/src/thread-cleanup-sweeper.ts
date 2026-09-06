// Daily async loop that prompts users about old Kimaki threads.
//
// For worktree/workspace threads:
//   - Looks at both thread_workspaces (modern SDK) and thread_worktrees (legacy)
//   - Checks if the branch has been merged (0 commits ahead of default branch)
//     and has no uncommitted changes
//   - If merged and clean: sends a message with "Clean up worktree & archive" / "Dismiss" buttons
//   - On confirm: removes the worktree on disk and archives the thread
//
// For non-worktree threads:
//   - Checks if the thread is older than 2 days
//   - If stale: sends a message with "Archive thread" / "Dismiss" buttons
//   - On confirm: archives the thread

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Routes,
  type ButtonInteraction,
  type Client,
  type REST,
} from 'discord.js'
import fs from 'node:fs'
import {
  getAllThreadIds,
  getThreadWorktree,
  getThreadWorkspace,
  getThreadCreatedAt,
  getCleanupPromptedAt,
  setCleanupPromptedAt,
  deleteThreadWorktree,
  deleteThreadWorkspace,
} from './database.js'
import {
  deleteWorktree,
  isThreadWorktreeMergedAndClean,
  removeOpencodeWorkspace,
} from './worktrees.js'
import { registerHtmlAction, pendingHtmlActions } from './html-actions.js'
import { createLogger, formatErrorWithStack } from './logger.js'
import { archiveOpenCodeSessionForThread } from './discord-utils.js'

const cleanupLogger = createLogger('CLEANUP')

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const CLEANUP_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REPROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const NEVER_REPROMPT_AT = new Date('9999-12-31T00:00:00Z')
const DISCORD_EPOCH = 1420070400000n

function snowflakeTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH)
}

export function startThreadCleanupSweeper({
  discordClient,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
}: {
  discordClient: Client
  sweepIntervalMs?: number
}): () => Promise<void> {
  let stopped = false
  let sweeping = false
  let sweepPromise: Promise<void> | null = null

  const sweep = async () => {
    if (stopped || sweeping) return
    sweeping = true

    const currentSweepPromise = (async () => {
      const rest = discordClient.rest
      const threadIds = await getAllThreadIds()
      cleanupLogger.log(`Cleanup sweep: evaluating ${threadIds.length} thread(s)`)

      for (const threadId of threadIds) {
        if (stopped) break
        try {
          await evaluateThreadForCleanup({
            threadId,
            rest,
          })
        } catch (error) {
          cleanupLogger.error(`Error evaluating thread ${threadId}:`, formatErrorWithStack(error))
        }
      }

      cleanupLogger.log('Cleanup sweep complete')
    })()

    sweepPromise = currentSweepPromise
    await currentSweepPromise.finally(() => {
      sweeping = false
      sweepPromise = null
    })
  }

  setTimeout(() => void sweep(), 60_000)
  const interval = setInterval(() => void sweep(), sweepIntervalMs)

  cleanupLogger.log(`Thread cleanup sweeper started (interval=${sweepIntervalMs}ms)`)

  return async () => {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    if (sweepPromise) {
      await sweepPromise
      sweepPromise = null
    }
    cleanupLogger.log('Thread cleanup sweeper stopped')
  }
}

function hasPendingCleanupAction(threadId: string): boolean {
  for (const [, action] of pendingHtmlActions) {
    if (action.threadId === threadId && action.ownerKey === `cleanup:${threadId}`) {
      return true
    }
  }
  return false
}

// Unified worktree-or-workspace row used by the sweeper. Either table can
// drive a cleanup prompt — modern SDK workspaces carry a `workspace_id`
// that selects the SDK removal path; legacy rows fall back to direct git
// worktree removal.
type ThreadWorktreeRow = {
  directory: string | null
  projectDirectory: string
  branch: string
  // null = legacy worktree without an OpenCode workspace_id (use git directly).
  // string = SDK workspace, must be removed via OpenCode SDK.
  workspaceId: string | null
  // 'workspace' or 'worktree' — selects which DB row to delete on confirm.
  source: 'workspace' | 'worktree'
}

export async function evaluateThreadForCleanup({
  threadId,
  rest,
}: {
  threadId: string
  rest: REST
}): Promise<void> {
  if (hasPendingCleanupAction(threadId)) return

  const lastPrompted = await getCleanupPromptedAt(threadId)
  if (lastPrompted && Date.now() - lastPrompted.getTime() < REPROMPT_COOLDOWN_MS) return

  // Fetch thread info: archived status and last message timestamp
  try {
    const channel = (await rest.get(Routes.channel(threadId))) as {
      archived?: boolean
      last_message_id?: string | null
    } | null
    if (channel?.archived) {
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
      return
    }
    if (channel?.last_message_id) {
      const lastMsgTs = snowflakeTimestamp(channel.last_message_id)
      if (Date.now() - lastMsgTs < TWO_DAYS_MS) {
        return // recent activity, skip
      }
    }
  } catch {
    // if we can't fetch, proceed anyway
  }

  // Check modern workspace table first, fall back to legacy worktrees. Both
  // tables can be queried because pre-migration threads may still have
  // legacy rows even when new ones are created in the modern table.
  const workspace = await getThreadWorkspace(threadId)
  const worktree = workspace ? undefined : await getThreadWorktree(threadId)

  const unified: ThreadWorktreeRow | null = workspace
    ? workspace.status === 'ready' && workspace.workspace_directory
      ? {
          directory: workspace.workspace_directory,
          projectDirectory: workspace.project_directory,
          branch: workspace.workspace_name,
          workspaceId: workspace.workspace_id ?? null,
          source: 'workspace',
        }
      : null
    : worktree
      ? worktree.status === 'ready' && worktree.worktree_directory
        ? {
            directory: worktree.worktree_directory,
            projectDirectory: worktree.project_directory,
            branch: worktree.worktree_name,
            workspaceId: null,
            source: 'worktree',
          }
        : null
      : null

  if (unified) {
    await evaluateWorktreeThread({ threadId, row: unified, rest })
  } else {
    await evaluateNormalThread({ threadId, rest })
  }
}

async function evaluateWorktreeThread({
  threadId,
  row,
  rest,
}: {
  threadId: string
  row: ThreadWorktreeRow
  rest: REST
}): Promise<void> {
  if (!row.directory) return

  const createdAt = await getThreadCreatedAt(threadId)
  if (createdAt && Date.now() - createdAt.getTime() < TWO_DAYS_MS) return

  const worktreeDir = row.directory
  const projectDir = row.projectDirectory

  let dirExists: boolean
  try {
    await fs.promises.access(worktreeDir)
    dirExists = true
  } catch {
    dirExists = false
  }

  // If the directory is already gone, no git check is needed — prompt to
  // archive the thread only. Otherwise require the branch to be merged &
  // clean before we'll offer destructive cleanup.
  const isMerged = dirExists
    ? await isThreadWorktreeMergedAndClean({
        worktreeDir,
        projectDir,
      })
    : true

  if (!isMerged) return

  const cleanupActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Cleanup in progress...',
        components: [],
      })

      let cleanupError: Error | null = null
      if (dirExists) {
        const delResult = row.workspaceId
          ? await removeOpencodeWorkspace({
              projectDirectory: projectDir,
              workspaceId: row.workspaceId,
              cleanupBranch: true,
              branchName: row.branch,
            })
          : await deleteWorktree({
              projectDirectory: projectDir,
              worktreeDirectory: worktreeDir,
              worktreeName: row.branch,
            })
        if (delResult instanceof Error) {
          cleanupError = delResult
          cleanupLogger.error(
            `Failed to delete ${row.source} ${row.branch}: ${delResult.message}`,
          )
          await interaction.followUp({
            content: `Failed to clean up worktree: ${delResult.message}`,
            flags: 64,
          })
          return
        }
      }

      if (row.source === 'workspace') {
        await deleteThreadWorkspace(threadId)
      } else {
        await deleteThreadWorktree(threadId)
      }
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)

      try {
        await rest.patch(Routes.channel(threadId), {
          body: { archived: true },
        })
        const ocResult = await archiveOpenCodeSessionForThread({
          threadId,
          projectDirectory: projectDir,
          workingDirectory: worktreeDir,
        })
        if (ocResult instanceof Error) {
          cleanupLogger.warn(
            `Failed to archive OpenCode session for thread ${threadId}:`,
            formatErrorWithStack(ocResult),
          )
        }
        await interaction.editReply({
          content: cleanupError
            ? 'Thread archived but worktree cleanup failed.'
            : 'Worktree cleaned up and thread archived.',
          components: [],
        })
      } catch (archiveError) {
        cleanupLogger.warn(
          `Failed to archive thread ${threadId} after cleanup:`,
          formatErrorWithStack(archiveError),
        )
        await interaction.editReply({
          content: 'Worktree cleaned up but failed to archive thread.',
          components: [],
        })
      }
    },
  })

  const dismissActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
      await interaction.editReply({
        content: dirExists ? 'Worktree cleanup dismissed.' : 'Archive dismissed.',
        components: [],
      })
    },
  })

  const row$ = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`html_action:${cleanupActionId}`)
      .setLabel('Clean up worktree & archive')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`html_action:${dismissActionId}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary),
  )

  try {
    await rest.post(Routes.channelMessages(threadId), {
      body: {
        content: dirExists
          ? 'Your worktree changes have been merged into the default branch. Clean up the worktree and archive this thread?'
          : 'The worktree directory for this thread no longer exists. Archive this thread?',
        components: [row$],
      },
    })
    cleanupLogger.log(`Sent cleanup prompt for ${row.source} thread ${threadId}`)
  } catch {
    cleanupLogger.log(`Could not send cleanup prompt for thread ${threadId} (may be archived)`)
  }
}

async function evaluateNormalThread({
  threadId,
  rest,
}: {
  threadId: string
  rest: REST
}): Promise<void> {
  const createdAt = await getThreadCreatedAt(threadId)
  if (!createdAt) return

  const age = Date.now() - createdAt.getTime()
  if (age < TWO_DAYS_MS) return

  const archiveActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Archiving thread...',
        components: [],
      })

      try {
        await rest.patch(Routes.channel(threadId), {
          body: { archived: true },
        })
        const ocResult = await archiveOpenCodeSessionForThread({ threadId })
        if (ocResult instanceof Error) {
          cleanupLogger.warn(
            `Failed to archive OpenCode session for thread ${threadId}:`,
            formatErrorWithStack(ocResult),
          )
        }
        await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
        await interaction.editReply({
          content: 'Thread archived.',
          components: [],
        })
      } catch (archiveError) {
        cleanupLogger.warn(
          `Failed to archive thread ${threadId}:`,
          formatErrorWithStack(archiveError),
        )
        await interaction.editReply({
          content: 'Failed to archive thread.',
          components: [],
        })
      }
    },
  })

  const dismissActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
      await interaction.editReply({
        content: 'Prompt dismissed.',
        components: [],
      })
    },
  })

  const row$ = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`html_action:${archiveActionId}`)
      .setLabel('Archive thread')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`html_action:${dismissActionId}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary),
  )

  try {
    await rest.post(Routes.channelMessages(threadId), {
      body: {
        content:
          'This thread has been inactive for over 2 days. Archive it to keep things tidy?\nYou can resume anytime by sending a message here.',
        components: [row$],
      },
    })
    cleanupLogger.log(`Sent archive prompt for inactive thread ${threadId}`)
  } catch {
    cleanupLogger.log(`Could not send archive prompt for thread ${threadId} (may be archived)`)
  }
}
