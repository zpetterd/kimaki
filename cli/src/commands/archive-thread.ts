// Manual archive command - /archive-thread
// Immediately archives the current thread without confirmation.

import {
  ChannelType,
  MessageFlags,
  Routes,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { createLogger, formatErrorWithStack } from '../logger.js'
import {
  archiveOpenCodeSessionForThread,
  resolveWorkingDirectory,
} from '../discord-utils.js'

const logger = createLogger('ARCHIVE')

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

  try {
    await rest.patch(Routes.channel(channel.id), {
      body: { archived: true },
    })

    // Sync the OpenCode session so OpenChamber and OpenCode web show it as
    // archived. Failure here does not roll back the Discord archive — the
    // user already sees the thread archived, and we surface the OpenCode
    // error so they know OpenChamber may not be in sync.
    const resolved = await resolveWorkingDirectory({
      channel: channel as TextChannel | ThreadChannel,
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
