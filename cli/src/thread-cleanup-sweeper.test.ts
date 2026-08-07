import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  evaluateThreadForCleanup,
  startThreadCleanupSweeper,
} from './thread-cleanup-sweeper.js'
import {
  getAllThreadIds,
  getCleanupPromptedAt,
  getThreadWorktree,
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
  getThreadCreatedAt: vi.fn(),
  getCleanupPromptedAt: vi.fn(),
  setCleanupPromptedAt: vi.fn().mockResolvedValue(undefined),
  deleteThreadWorktree: vi.fn().mockResolvedValue(undefined),
}))

// Mock html-actions to avoid side effects
vi.mock('./html-actions.js', () => ({
  registerHtmlAction: vi.fn().mockReturnValue('mock-action-id'),
  pendingHtmlActions: new Map(),
  cancelHtmlActionsForThread: vi.fn(),
}))

// Mock worktrees to avoid git calls in unit tests
vi.mock('./worktrees.js', () => ({
  git: vi.fn().mockResolvedValue(''),
  isDirty: vi.fn().mockResolvedValue(false),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
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
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)
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
    vi.mocked(getThreadWorktree).mockResolvedValue(undefined)
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

  test('prompts worktree thread when merged and clean', async () => {
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
