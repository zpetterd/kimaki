// OpenCode session prompt helpers.
// Creates a session-stable system message injected into every OpenCode
// session, plus per-turn synthetic context for Discord/user/worktree metadata.
// Keep per-message data out of system prompt so prompt caching can reuse
// the same session prefix across turns.

export type WorktreeInfo = {
  /** The worktree directory path */
  worktreeDirectory: string;
  /** The branch name (e.g., opencode/kimaki-feature) */
  branch: string;
  /** The main repository directory */
  mainRepoDirectory: string;
};

export type RepliedMessageContext = {
  authorUsername?: string;
  text: string;
};

/** YAML marker embedded in thread starter message footer for bot to parse */
export type ThreadStartMarker = {
  /** Whether to auto-start an AI session */
  start?: boolean;
  /**
   * Legacy marker for CLI-injected prompts into existing threads.
   * @deprecated New injected prompts should use `start: true` instead.
   */
  cliThreadPrompt?: boolean;
  /** Worktree name to create */
  worktree?: string;
  /** Existing worktree directory to use as working directory (must be a git worktree of the project) */
  cwd?: string;
  /** Discord username who initiated the thread */
  username?: string;
  /** Discord user ID who initiated the thread */
  userId?: string;
  /** Agent to use for the session */
  agent?: string;
  /** Model to use (format: provider/model) */
  model?: string;
  /** Schedule kind for sessions started by scheduled tasks */
  scheduledKind?: "at" | "cron";
  /** Scheduled task ID that triggered this message */
  scheduledTaskId?: number;
  /**
   * Per-session permission overrides as raw "tool:action" or "tool:pattern:action"
   * strings. Parsed into PermissionRuleset entries by parsePermissionRules() in
   * opencode.ts and appended after buildSessionPermissions() so they win via
   * opencode's findLast() evaluation.
   */
  permissions?: string[];
  /**
   * Per-session injection guard scan patterns (e.g. "bash:*", "webfetch:*").
   * Written to a temp file after session creation so the injection guard plugin
   * can check per-session whether scanning is enabled.
   */
  injectionGuardPatterns?: string[];
};

export function isInjectedPromptMarker({
  marker,
}: {
  marker: ThreadStartMarker | undefined;
}): boolean {
  if (!marker) {
    return false;
  }
  return Boolean(marker.cliThreadPrompt || marker.start);
}

export type AgentInfo = {
  name: string;
  description?: string;
};

function escapePromptAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapePromptText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function getOpencodePromptContext({
  username,
  userId,
  sourceMessageId,
  sourceThreadId,
  repliedMessage,
  worktree,
  currentAgent,
  worktreeChanged,
}: {
  username?: string;
  userId?: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
  repliedMessage?: RepliedMessageContext;
  worktree?: WorktreeInfo;
  currentAgent?: string;
  worktreeChanged?: boolean;
}): string {
  const userAttrs = [
    ...(username ? [` name="${escapePromptAttribute(username)}"`] : []),
    ...(userId ? [` user-id="${escapePromptAttribute(userId)}"`] : []),
    ...(sourceMessageId
      ? [` message-id="${escapePromptAttribute(sourceMessageId)}"`]
      : []),
    ...(sourceThreadId
      ? [` thread-id="${escapePromptAttribute(sourceThreadId)}"`]
      : []),
  ].join("");
  const repliedMessageXml = repliedMessage
    ? `This message was a reply to message

<replied-message${repliedMessage.authorUsername ? ` author="${escapePromptAttribute(repliedMessage.authorUsername)}"` : ""}>
${escapePromptText(repliedMessage.text)}
</replied-message>`
    : undefined;
  const sections = [
    ...(userAttrs ? [`<discord-user${userAttrs} />`] : []),
    ...(repliedMessageXml ? [repliedMessageXml] : []),
    ...(currentAgent
      ? [
          `<system-reminder>\nCurrent agent: ${currentAgent}\n</system-reminder>`,
        ]
      : []),
    ...(worktree && worktreeChanged
      ? [
          `<system-reminder>\nThis session is running inside a git worktree.\n- Worktree path: ${worktree.worktreeDirectory}\n- Branch: ${worktree.branch}\n- Main repo: ${worktree.mainRepoDirectory}\nRun checks in this worktree. Do not create another worktree by default. Ask before merging changes back to the main branch.\n</system-reminder>`,
        ]
      : []),
  ];
  return sections.join("\n\n");
}

export function getOpencodeSystemMessage({
  sessionId,
  channelId,
  guildId,
  threadId,
  channelTopic,
  agents,
  username,
}: {
  sessionId: string;
  channelId?: string;
  /** Discord server/guild ID for discord_list_users tool */
  guildId?: string;
  /** Discord thread ID (the thread this session runs in) */
  threadId?: string;
  channelTopic?: string;
  agents?: AgentInfo[];
  username?: string;
}) {
  const userArg = ` --user ${JSON.stringify(username || "username")}`;
  const topicContext = channelTopic?.trim()
    ? `\n\n<channel-topic>\n${channelTopic.trim()}\n</channel-topic>`
    : "";
  const availableAgentsContext =
    agents && agents.length > 0
      ? `\n\nAvailable agents:\n${agents
          .map((agent) => {
            return `- \`${agent.name}\`${agent.description ? `: ${agent.description}` : ""}`;
          })
          .join("\n")}`
      : "";
  return `
The user is reading your messages from inside Discord, via kimaki.xyz


${topicContext}
`;
}
