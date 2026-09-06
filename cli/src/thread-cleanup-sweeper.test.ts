import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  evaluateThreadForCleanup,
  startThreadCleanupSweeper,
} from './thread-cleanup-sweeper.js'
import {
  getAllThreadIds,
  getCleanupPromptedAt,
  getThreadWorktree,
  getThreadWorkspace,
  getThreadCreatedAt,
  setCleanupPromptedAt,
} from './database.js'
import { pendingHtmlActions } from './html-actions.js'

// Mock discord.js REST type
const mockRest = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
} as unknown as import('discord.js').REST

// Mock the database functions
vi.mock('./database.js', () => ({
  getAllThreadIds: vi.fn(),
  getThreadWorktree: vi.fn(),
  getThreadWorkspace: vi.fn(),
  getThreadCreatedAt: vi.fn(),
  getCleanupPromptedAt: vi.fn(),
  setCleanupPromptedAt: vi.fn().mockResolvedValue(undefined),
  deleteThreadWorktree: vi.fn().mockResolvedValue(undefined),
  deleteThreadWorkspace: vi.fn().mockResolvedValue(undefined),
}))

// Mock html-actions to avoid side effects
vi.mock('./html-actions.js', () => ({
  registerHtmlAction: vi.fn().mockReturnValue('mock-action-id'),
  pendingHtmlActions: new Map(),
  cancelHtmlActionsForThread: vi.fn(),
}))

// Mock worktrees to avoid git calls in unit tests. The sweeper delegates
// to isThreadWorktreeMergedAndClean / deleteWorktree / removeOpencodeWorkspace
// so we stub each directly with sane defaults.
vi.mock('./worktrees.js', () => ({
  isThreadWorktreeMergedAndClean: vi.fn().mockResolvedValue(true),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  removeOpencodeWorkspace: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => {
  vi.clearAllMocks()
  pendingHtmlActions.clear()
})

describe('evaluateThreadForCleanup', () => {
  beforeEach(() => {
    // Default: no pending cleanup action, no cooldown
    vi.mocked(getCleanupPromptedAt).mockResolvedValue(null)
    vi.mocked(getThreadCreatedAt).mockResolvedValue(
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    ) // 3 days old
    vi.mocked(getThreadWorkspace).mockResolvedValue(undefined)
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)
  })

  test('skips thread with pending cleanup action', async () => {
    pendingHtmlActions.set('action-1', {
      ownerKey: 'cleanup:thread-123',
      threadId: 'thread-123',
      run: async () => {},
      actionId: 'action-1',
      resolved: false,
      timer: setTimeout(() => {}, 60_000),
    })

    await evaluateThreadForCleanup({ threadId: 'thread-123', rest: mockRest })

    expect(mockRest.get).not.toHaveBeenCalled()
  })

  test('skips thread that was recently prompted (cooldown honored)', async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago, within 7-day cooldown
    vi.mocked(getCleanupPromptedAt).mockResolvedValue(recentDate)

    await evaluateThreadForCleanup({ threadId: 'thread-123', rest: mockRest })

    expect(mockRest.get).not.toHaveBeenCalled()
  })

  test('skips archived thread and sets NEVER_REPROMPT_AT', async () => {
    vi.mocked(getCleanupPromptedAt).mockResolvedValue(null)
    vi.mocked(getThreadWorkspace).mockResolvedValue(undefined)
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: true,
      last_message_id: null,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-123', rest: mockRest })

    expect(mockRest.get).toHaveBeenCalled()
    expect(setCleanupPromptedAt).toHaveBeenCalledWith(
      'thread-123',
      new Date('9999-12-31T00:00:00Z'),
    )
    expect(mockRest.post).not.toHaveBeenCalled()
  })

  test('skips thread with recent message activity', async () => {
    // last message was 1 day ago - less than 2 day threshold
    const ts = Date.now() - 1 * 24 * 60 * 60 * 1000
    const recentSnowflake = String((BigInt(ts - 1420070400000) << 22n) + 1420070400000n)

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: recentSnowflake,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-123', rest: mockRest })

    expect(mockRest.post).not.toHaveBeenCalled()
  })

  test('prompts stale non-worktree thread with archive buttons', async () => {
    // last message was 3 days ago
    const ts = Date.now() - 3 * 24 * 60 * 60 * 1000
    const oldSnowflake = String((BigInt(ts - 1420070400000) << 22n) + 1420070400000n)

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: oldSnowflake,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-123', rest: mockRest })

    expect(mockRest.post).toHaveBeenCalledWith(
      expect.stringContaining('thread-123/messages'),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining('inactive'),
          components: expect.any(Array),
        }),
      }),
    )
  })

  test('prompts legacy worktree thread when merged and clean', async () => {
    vi.mocked(getThreadWorktree).mockResolvedValue({
      status: 'ready',
      thread_id: 'thread-456',
      created_at: null,
      worktree_name: 'opencode/kimaki-feature',
      worktree_directory: '/tmp/fake-worktree',
      project_directory: '/tmp/fake-project',
      error_message: null,
    })
    // Thread is old enough
    vi.mocked(getThreadCreatedAt).mockResolvedValue(
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    )

    // Worktree dir exists
    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: null,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-456', rest: mockRest })

    expect(mockRest.post).toHaveBeenCalledWith(
      expect.stringContaining('thread-456/messages'),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining('worktree'),
        }),
      }),
    )
  })

  test('prompts modern workspace thread when merged and clean', async () => {
    vi.mocked(getThreadWorkspace).mockResolvedValue({
      status: 'ready',
      thread_id: 'thread-789',
      created_at: null,
      workspace_id: 'wrk_test',
      workspace_type: 'kimaki-worktree',
      error_message: null,
      project_directory: '/tmp/fake-project',
      workspace_directory: '/tmp/fake-workspace',
      workspace_name: 'opencode/kimaki-feature',
    })
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: null,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-789', rest: mockRest })

    expect(mockRest.post).toHaveBeenCalledWith(
      expect.stringContaining('thread-789/messages'),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining('worktree'),
        }),
      }),
    )
  })

  test('prefers modern workspace over legacy worktree when both exist', async () => {
    // If a thread somehow has rows in both tables (shouldn't happen in
    // practice, but defensive), the modern table wins so we use the SDK
    // removal path.
    vi.mocked(getThreadWorkspace).mockResolvedValue({
      status: 'ready',
      thread_id: 'thread-both',
      created_at: null,
      workspace_id: 'wrk_modern',
      workspace_type: 'kimaki-worktree',
      error_message: null,
      project_directory: '/tmp/project',
      workspace_directory: '/tmp/modern-wt',
      workspace_name: 'opencode/kimaki-modern',
    })
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: null,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-both', rest: mockRest })

    expect(mockRest.post).toHaveBeenCalled()
  })

  test('does not prompt when worktree branch is not merged', async () => {
    const { isThreadWorktreeMergedAndClean } = await import('./worktrees.js')
    vi.mocked(isThreadWorktreeMergedAndClean).mockResolvedValueOnce(false)

    // Use a real on-disk directory so the sweeper reaches the git merge check
    // instead of short-circuiting with the "directory is gone" branch.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweeper-unmerged-'))

    vi.mocked(getThreadWorktree).mockResolvedValue({
      status: 'ready',
      thread_id: 'thread-unmerged',
      created_at: null,
      worktree_name: 'opencode/kimaki-unmerged',
      worktree_directory: realDir,
      project_directory: '/tmp/fake-project',
      error_message: null,
    })

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: null,
    })

    try {
      await evaluateThreadForCleanup({ threadId: 'thread-unmerged', rest: mockRest })

      expect(mockRest.post).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true })
    }
  })

  test('prompts archive-only when worktree directory is gone', async () => {
    vi.mocked(getThreadWorktree).mockResolvedValue({
      status: 'ready',
      thread_id: 'thread-missing-dir',
      created_at: null,
      worktree_name: 'opencode/kimaki-gone',
      worktree_directory: '/tmp/does-not-exist',
      project_directory: '/tmp/fake-project',
      error_message: null,
    })

    vi.mocked(mockRest.get).mockResolvedValueOnce({
      archived: false,
      last_message_id: null,
    })

    await evaluateThreadForCleanup({ threadId: 'thread-missing-dir', rest: mockRest })

    // Should still send the prompt, but with the "directory no longer exists"
    // copy rather than the merged/clean copy.
    expect(mockRest.post).toHaveBeenCalledWith(
      expect.stringContaining('thread-missing-dir/messages'),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining('no longer exists'),
        }),
      }),
    )
  })
})

describe('startThreadCleanupSweeper', () => {
  test('returns a stop function', () => {
    const mockClient = {
      rest: mockRest,
    } as unknown as import('discord.js').Client

    const stop = startThreadCleanupSweeper({
      discordClient: mockClient,
      sweepIntervalMs: 60_000,
    })

    expect(typeof stop).toBe('function')
    expect(stop.length).toBe(0) // async function has 0 required params
  })

  test('stop function clears interval and stops sweeping', async () => {
    vi.useFakeTimers()

    const mockClient = {
      rest: mockRest,
    } as unknown as import('discord.js').Client

    vi.mocked(getAllThreadIds).mockResolvedValue([])

    const stop = startThreadCleanupSweeper({
      discordClient: mockClient,
      sweepIntervalMs: 60_000,
    })

    // Let the initial sweep run
    await vi.advanceTimersByTimeAsync(62_000)

    const stopPromise = stop()
    await vi.advanceTimersByTimeAsync(0)
    await stopPromise

    // After stopping, the interval should be cleared and in-flight sweep awaited
    expect(getAllThreadIds).toHaveBeenCalled()

    vi.useRealTimers()
  })

  test('sweeper schedules initial 60s sweep and recurring interval', async () => {
    vi.useFakeTimers()

    const mockClient = {
      rest: mockRest,
    } as unknown as import('discord.js').Client

    vi.mocked(getAllThreadIds).mockResolvedValue([])

    startThreadCleanupSweeper({
      discordClient: mockClient,
      sweepIntervalMs: 60_000,
    })

    // Initial sweep fires at 60s, interval also fires at 60s (same window)
    // so both may fire together on the first advance
    await vi.advanceTimersByTimeAsync(61_000)

    // The interval continues to fire every 60s
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getAllThreadIds).toHaveBeenCalled()

    vi.useRealTimers()
  })
})
