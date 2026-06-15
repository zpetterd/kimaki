// Manual archive command - /archive-thread
// Triggers the cleanup evaluation for the current thread immediately.

import { ChannelType, MessageFlags } from 'discord.js'
import type { CommandContext } from './types.js'
import { createLogger, formatErrorWithStack } from '../logger.js'

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

  // Lazy-import to avoid circular dependency at module load time
  const { evaluateThreadForCleanup: evaluateForCleanup } =
    await import('../thread-cleanup-sweeper.js')

  const rest = command.client.rest

  try {
    await evaluateForCleanup({ threadId: channel.id, rest })
    await command.editReply({ content: 'Cleanup evaluation done.' })
  } catch (error) {
    logger.error(`Error evaluating thread ${channel.id}:`, formatErrorWithStack(error))
    await command.editReply({ content: 'Cleanup evaluation failed.' })
  }
}

const threadTypes = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]

export const archiveThreadSlashCommand = {
  name: 'archive-thread',
  description: 'Manually trigger the cleanup evaluation for this thread',
  allowedChannelTypes: threadTypes,
}
