// Manual archive command - /archive-thread
// Immediately archives the current thread. If the thread has a git worktree
// whose branch is merged and clean, the user is offered a one-click option
// to also delete the worktree — otherwise the directory lingers on disk
// forever. Choose "Archive only" to skip cleanup.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  Routes,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import fs from 'node:fs'
import type { CommandContext } from './types.js'
import { createLogger, formatErrorWithStack } from '../logger.js'
import {
  archiveOpenCodeSessionForThread,
  resolveWorkingDirectory,
} from '../discord-utils.js'
import { getThreadWorktreeOrWorkspace, deleteThreadWorkspace } from '../database.js'
import { buildHtmlActionCustomId, registerHtmlAction } from '../html-actions.js'
import {
  deleteWorktree,
  isThreadWorktreeMergedAndClean,
  removeOpencodeWorkspace,
} from '../worktrees.js'

const logger = createLogger('ARCHIVE')

// 10 minutes is enough for a user to click a button right after running the
// slash command. Long enough that a slow Discord roundtrip won't expire the
// prompt; short enough that stale prompts can't fire hours later.
const ARCHIVE_PROMPT_TTL_MS = 10 * 60 * 1000

export async function handleArchiveThreadCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel || !channel.isThread()) {
    await command.reply({
      content: 'This command can only be used in a thread.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const rest = command.client.rest
  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  // Decide whether we can offer worktree cleanup. Only when the worktree
  // exists on disk AND its branch is merged into default AND it's clean —
  // otherwise deletion would silently lose unmerged or dirty work.
  const cleanupOffer = resolved
    ? await buildArchiveCleanupOffer({ threadId: channel.id, projectDir: resolved.projectDirectory })
    : null

  if (cleanupOffer?.canCleanup) {
    logger.log(`[archive-thread] Offering cleanup for thread ${channel.id} (worktree: ${cleanupOffer.worktreeDir})`)
    await promptArchiveWithCleanupChoice({ command, cleanupOffer, channelId: channel.id })
    return
  }

  logger.log(`[archive-thread] No cleanup offer for thread ${channel.id} (resolved=${Boolean(resolved)})`)

  // No cleanup offer (no worktree, or worktree isn't merged & clean):
  // fall through to the existing archive-only behavior.
  try {
    await rest.patch(Routes.channel(channel.id), {
      body: { archived: true },
    })

    if (resolved) {
      const result = await archiveOpenCodeSessionForThread({
        threadId: channel.id,
        projectDirectory: resolved.projectDirectory,
        workingDirectory: resolved.workingDirectory,
      })
      if (result instanceof Error) {
        logger.warn(
          `[archive-thread] OpenCode session archive failed: ${result.message}`,
        )
        await command.editReply({
          content: `Thread archived, but OpenCode session archive failed: ${result.message}`,
        })
        return
      }
    }

    await command.editReply({ content: 'Thread archived.' })
  } catch (error) {
    logger.error(`Error archiving thread ${channel.id}:`, formatErrorWithStack(error))
    await command.editReply({ content: 'Failed to archive thread.' })
  }
}

type ArchiveCleanupOffer = {
  canCleanup: true
  // Path to the worktree/workspace directory on disk. May already be gone
  // if a previous cleanup partially succeeded; we re-check before deleting.
  worktreeDir: string
  projectDir: string
  branch: string
  // null = legacy worktree without an OpenCode workspace_id (use git directly).
  // string = SDK workspace, must be removed via OpenCode SDK.
  workspaceId: string | null
}

async function buildArchiveCleanupOffer({
  threadId,
  projectDir,
}: {
  threadId: string
  projectDir: string
}): Promise<ArchiveCleanupOffer | null> {
  const workspace = await getThreadWorktreeOrWorkspace(threadId)
  if (!workspace) {
    logger.log(`[archive-thread] No workspace row for thread ${threadId}`)
    return null
  }
  if (workspace.status !== 'ready') {
    logger.log(`[archive-thread] Workspace status='${workspace.status}' for thread ${threadId} (skipping)`)
    return null
  }

  // Use the workspace_directory when present (modern), otherwise fall back
  // to the DB row's working directory via archiveOpenCodeSessionForThread
  // — which resolves legacy worktree_directory.
  const directory = workspace.workspace_directory ?? undefined
  if (!directory) {
    logger.log(`[archive-thread] Workspace row has no directory for thread ${threadId}`)
    return null
  }

  let dirExists = true
  try {
    await fs.promises.access(directory)
  } catch {
    dirExists = false
  }

  // If the directory is already gone there's nothing to delete; skip the offer.
  if (!dirExists) {
    logger.log(`[archive-thread] Worktree directory missing for thread ${threadId}: ${directory}`)
    return null
  }

  const safe = await isThreadWorktreeMergedAndClean({
    worktreeDir: directory,
    projectDir,
  })
  if (!safe) {
    logger.log(`[archive-thread] Worktree not merged/clean for thread ${threadId}: ${directory}`)
    return null
  }

  return {
    canCleanup: true,
    worktreeDir: directory,
    projectDir,
    branch: workspace.workspace_name,
    workspaceId: workspace.workspace_id ?? null,
  }
}

async function promptArchiveWithCleanupChoice({
  command,
  cleanupOffer,
  channelId,
}: {
  command: CommandContext['command']
  cleanupOffer: ArchiveCleanupOffer
  channelId: string
}): Promise<void> {
  const cleanupActionId = registerHtmlAction({
    ownerKey: `archive:${channelId}`,
    threadId: channelId,
    ttlMs: ARCHIVE_PROMPT_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Cleaning up worktree and archiving thread…',
        components: [],
      })

      const cleanupResult = await cleanupThreadWorktreeAndArchive({
        rest: command.client.rest,
        threadId: channelId,
        cleanupOffer,
      })

      if (cleanupResult.kind === 'ok') {
        await interaction.editReply({
          content: 'Worktree cleaned up and thread archived.',
          components: [],
        })
        return
      }

      if (cleanupResult.kind === 'archive-only') {
        await interaction.editReply({
          content: 'Thread archived. Worktree cleanup failed: ' + cleanupResult.message,
          components: [],
        })
        return
      }

      await interaction.editReply({
        content: 'Failed to clean up worktree: ' + cleanupResult.message,
        components: [],
      })
    },
  })

  const archiveOnlyActionId = registerHtmlAction({
    ownerKey: `archive:${channelId}`,
    threadId: channelId,
    ttlMs: ARCHIVE_PROMPT_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Archiving thread…',
        components: [],
      })

      await command.client.rest
        .patch(Routes.channel(channelId), { body: { archived: true } })
        .catch((e) => {
          throw e instanceof Error ? e : new Error(String(e))
        })

      const resolved = await resolveWorkingDirectory({
        channel: command.channel as TextChannel | ThreadChannel,
      })
      if (resolved) {
        const result = await archiveOpenCodeSessionForThread({
          threadId: channelId,
          projectDirectory: resolved.projectDirectory,
          workingDirectory: resolved.workingDirectory,
        })
        if (result instanceof Error) {
          logger.warn(
            `[archive-thread] OpenCode session archive failed: ${result.message}`,
          )
        }
      }

      await interaction.editReply({
        content: 'Thread archived. Worktree left on disk.',
        components: [],
      })
    },
  })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildHtmlActionCustomId(cleanupActionId))
      .setLabel('Archive + clean up worktree')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildHtmlActionCustomId(archiveOnlyActionId))
      .setLabel('Archive only')
      .setStyle(ButtonStyle.Secondary),
  )

  await command.editReply({
    content:
      'This thread has a git worktree whose branch is merged into the default branch. Clean it up too, or archive the thread only?',
    components: [row],
  })
}

type CleanupResult =
  | { kind: 'ok' }
  | { kind: 'archive-only'; message: string }
  | { kind: 'cleanup-failed'; message: string }

export async function cleanupThreadWorktreeAndArchive({
  rest,
  threadId,
  cleanupOffer,
}: {
  rest: CommandContext['command']['client']['rest']
  threadId: string
  cleanupOffer: ArchiveCleanupOffer
}): Promise<CleanupResult> {
  const { worktreeDir, projectDir, branch, workspaceId } = cleanupOffer

  let deleteError: Error | null = null
  if (workspaceId) {
    const result = await removeOpencodeWorkspace({
      projectDirectory: projectDir,
      workspaceId,
      cleanupBranch: true,
      branchName: branch,
    })
    if (result instanceof Error) deleteError = result
  } else {
    const result = await deleteWorktree({
      projectDirectory: projectDir,
      worktreeDirectory: worktreeDir,
      worktreeName: branch,
    })
    if (result instanceof Error) deleteError = result
  }

  // Always delete the DB row + archive the thread, even when git cleanup
  // failed — the user explicitly chose to clean up, and a half-cleaned
  // workspace is worse than an archived thread without a cleanup.
  // The slash command only inspects thread_workspaces (modern SDK rows);
  // legacy thread_worktrees rows are not surfaced here and would need a
  // separate cleanup pass.
  await deleteThreadWorkspace(threadId).catch((e) => {
    logger.warn(`[archive-thread] Failed to delete workspace DB row: ${e}`)
  })

  try {
    await rest.patch(Routes.channel(threadId), {
      body: { archived: true },
    })
  } catch (error) {
    return {
      kind: 'cleanup-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const ocResult = await archiveOpenCodeSessionForThread({
    threadId,
    projectDirectory: projectDir,
    workingDirectory: worktreeDir,
  })
  if (ocResult instanceof Error) {
    logger.warn(
      `[archive-thread] OpenCode session archive failed: ${ocResult.message}`,
    )
  }

  if (deleteError) {
    return { kind: 'archive-only', message: deleteError.message }
  }

  return { kind: 'ok' }
}

const threadTypes = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]

export const archiveThreadSlashCommand = {
  name: 'archive-thread',
  description: 'Immediately archive this thread without confirmation',
  allowedChannelTypes: threadTypes,
}
