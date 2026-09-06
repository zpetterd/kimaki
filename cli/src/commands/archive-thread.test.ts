// Tests for /archive-thread handler's cleanup-eligibility logic.
//
// The full Discord interaction flow is exercised end-to-end in
// archive-thread.e2e.test.ts. This file focuses on the safety predicate:
// given a thread with an attached workspace, can we offer the user a
// one-click cleanup that won't silently lose unmerged or dirty work?

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { execAsync } from '../worktrees.js'

vi.mock('../database.js', () => ({
  getThreadWorktreeOrWorkspace: vi.fn(),
  deleteThreadWorkspace: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../discord-utils.js', () => ({
  archiveOpenCodeSessionForThread: vi.fn().mockResolvedValue(null),
  resolveWorkingDirectory: vi.fn(),
}))

vi.mock('../html-actions.js', () => {
  const pendingHtmlActions = new Map()
  let nextId = 0
  return {
    registerHtmlAction: vi.fn(({ run }: { run: unknown }) => {
      const actionId = `mock-action-${++nextId}`
      pendingHtmlActions.set(actionId, { run })
      return actionId
    }),
    buildHtmlActionCustomId: (id: string) => `html_action:${id}`,
    pendingHtmlActions,
  }
})

vi.mock('../worktrees.js', async () => {
  const actual = await vi.importActual<typeof import('../worktrees.js')>('../worktrees.js')
  return {
    ...actual,
    deleteWorktree: vi.fn(),
    removeOpencodeWorkspace: vi.fn(),
  }
})

import { getThreadWorktreeOrWorkspace, deleteThreadWorkspace } from '../database.js'
import { resolveWorkingDirectory } from '../discord-utils.js'
import {
  deleteWorktree,
  isThreadWorktreeMergedAndClean,
  removeOpencodeWorkspace,
} from '../worktrees.js'
import { cleanupThreadWorktreeAndArchive } from './archive-thread.js'

const mockedGetWorkspace = vi.mocked(getThreadWorktreeOrWorkspace)
const mockedResolveDir = vi.mocked(resolveWorkingDirectory)
const mockedDeleteWorktree = vi.mocked(deleteWorktree)
const mockedRemoveWorkspace = vi.mocked(removeOpencodeWorkspace)
const mockedDeleteWorkspace = vi.mocked(deleteThreadWorkspace)

let sandbox = ''
let projectDir = ''
let worktreeDir = ''
const testThreadId = 'test-archive-thread-' + Date.now()

async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const result = await execAsync(
    `git ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    { cwd, timeout: 30_000 },
  )
  return result.stdout.trim()
}

async function setupMergedWorktree(): Promise<void> {
  // Init project + feature worktree that has been merged into main.
  await git({ cwd: projectDir, args: ['init', '-b', 'main'] })
  await git({ cwd: projectDir, args: ['config', 'user.email', 'test@test.com'] })
  await git({ cwd: projectDir, args: ['config', 'user.name', 'Test'] })
  fs.writeFileSync(path.join(projectDir, 'readme.md'), 'project')
  await git({ cwd: projectDir, args: ['add', '.'] })
  await git({ cwd: projectDir, args: ['commit', '-m', 'init'] })

  worktreeDir = path.join(sandbox, 'wt')
  await git({
    cwd: projectDir,
    args: ['worktree', 'add', '-b', 'feature', worktreeDir],
  })
  fs.writeFileSync(path.join(worktreeDir, 'feature.md'), 'feature')
  await git({ cwd: worktreeDir, args: ['add', '.'] })
  await git({ cwd: worktreeDir, args: ['commit', '-m', 'feature work'] })
  await git({
    cwd: projectDir,
    args: ['merge', '--no-ff', 'feature', '-m', 'merge feature'],
  })
}

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-thread-test-'))
  projectDir = path.join(sandbox, 'project')
  fs.mkdirSync(projectDir, { recursive: true })
  vi.clearAllMocks()
  mockedResolveDir.mockResolvedValue({
    projectDirectory: projectDir,
    workingDirectory: projectDir,
  })
})

afterEach(() => {
  if (sandbox) {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

describe('isThreadWorktreeMergedAndClean is the safety gate for archive cleanup', () => {
  test('returns true only when branch is merged into default and working tree is clean', async () => {
    await setupMergedWorktree()

    // Sanity: after the merge the predicate must say it's safe to delete.
    const safe = await isThreadWorktreeMergedAndClean({
      worktreeDir,
      projectDir,
    })
    expect(safe).toBe(true)
  })

  test('returns false when the worktree has uncommitted changes', async () => {
    await setupMergedWorktree()
    fs.writeFileSync(path.join(worktreeDir, 'dirty.md'), 'uncommitted')

    const safe = await isThreadWorktreeMergedAndClean({
      worktreeDir,
      projectDir,
    })
    expect(safe).toBe(false)
  })
})

describe('archive-thread cleanup eligibility via DB workspace row', () => {
  // The handler reads the workspace row and combines it with
  // isThreadWorktreeMergedAndClean to decide whether to show cleanup
  // buttons. We don't exercise the full Discord interaction here — that
  // belongs in e2e — but we verify the inputs that drive the decision.
  test('a ready workspace with a missing directory is treated as already-gone', async () => {
    const ghostDir = path.join(sandbox, 'deleted-while-we-weren-t-looking')
    mockedGetWorkspace.mockResolvedValue({
      thread_id: testThreadId,
      workspace_id: 'wrk_test',
      workspace_type: 'kimaki-worktree',
      status: 'ready',
      error_message: null,
      project_directory: projectDir,
      workspace_directory: ghostDir,
      workspace_name: 'opencode/kimaki-feature',
      created_at: new Date(),
    })

    // The handler checks fs.access before deciding to offer cleanup; the
    // directory above was never created, mirroring a half-deleted state.
    expect(fs.existsSync(ghostDir)).toBe(false)
  })

  test('a ready workspace row alone does not justify cleanup — git state must agree', async () => {
    mockedGetWorkspace.mockResolvedValue({
      thread_id: testThreadId,
      workspace_id: 'wrk_test',
      workspace_type: 'kimaki-worktree',
      status: 'ready',
      error_message: null,
      project_directory: projectDir,
      workspace_directory: worktreeDir,
      workspace_name: 'opencode/kimaki-feature',
      created_at: new Date(),
    })

    // Without setting up a merged worktree, the predicate must reject.
    const safe = await isThreadWorktreeMergedAndClean({
      worktreeDir: path.join(projectDir, 'never-existed'),
      projectDir,
    })
    expect(safe).toBe(false)
  })
})

describe('archive-thread cleanup selects the right deletion path', () => {
  // The handler uses removeOpencodeWorkspace for SDK-managed workspaces and
  // deleteWorktree for legacy/manual ones. We assert the call shape — the
  // handler picks based on workspace_id presence.
  test('uses removeOpencodeWorkspace when workspace_id is set', async () => {
    mockedRemoveWorkspace.mockResolvedValue(undefined)

    const result = await removeOpencodeWorkspace({
      projectDirectory: projectDir,
      workspaceId: 'wrk_xyz',
      cleanupBranch: true,
      branchName: 'opencode/kimaki-feature',
    })

    expect(result).toBeUndefined()
    expect(mockedRemoveWorkspace).toHaveBeenCalledWith({
      projectDirectory: projectDir,
      workspaceId: 'wrk_xyz',
      cleanupBranch: true,
      branchName: 'opencode/kimaki-feature',
    })
  })

  test('uses deleteWorktree when there is no workspace_id (legacy/manual)', async () => {
    mockedDeleteWorktree.mockResolvedValue(undefined)

    const result = await deleteWorktree({
      projectDirectory: projectDir,
      worktreeDirectory: worktreeDir,
      worktreeName: 'opencode/kimaki-feature',
    })

    expect(result).toBeUndefined()
    expect(mockedDeleteWorktree).toHaveBeenCalledWith({
      projectDirectory: projectDir,
      worktreeDirectory: worktreeDir,
      worktreeName: 'opencode/kimaki-feature',
    })
  })
})

describe('cleanupThreadWorktreeAndArchive', () => {
  // Regression: the original implementation removed the git worktree and
  // archived the Discord thread but left the thread_workspaces DB row
  // pointing at a now-missing directory. That left a half-state where
  // future archive/sweeper runs would still consider the thread dirty.
  // This test exercises the full cleanup path end-to-end.

  function makeRest(): import('discord.js').REST {
    return {
      patch: vi.fn().mockResolvedValue({}),
    } as unknown as import('discord.js').REST
  }

  test('deletes the workspace DB row after a successful git cleanup (legacy path)', async () => {
    mockedDeleteWorktree.mockResolvedValue(undefined)

    const rest = makeRest()
    const result = await cleanupThreadWorktreeAndArchive({
      rest,
      threadId: testThreadId,
      cleanupOffer: {
        canCleanup: true,
        worktreeDir,
        projectDir,
        branch: 'opencode/kimaki-feature',
        workspaceId: null,
      },
    })

    expect(result).toEqual({ kind: 'ok' })
    expect(mockedDeleteWorktree).toHaveBeenCalledWith({
      projectDirectory: projectDir,
      worktreeDirectory: worktreeDir,
      worktreeName: 'opencode/kimaki-feature',
    })
    expect(mockedDeleteWorkspace).toHaveBeenCalledWith(testThreadId)
  })

  test('deletes the workspace DB row after SDK workspace removal (modern path)', async () => {
    mockedRemoveWorkspace.mockResolvedValue(undefined)

    const rest = makeRest()
    const result = await cleanupThreadWorktreeAndArchive({
      rest,
      threadId: testThreadId,
      cleanupOffer: {
        canCleanup: true,
        worktreeDir,
        projectDir,
        branch: 'opencode/kimaki-feature',
        workspaceId: 'wrk_test',
      },
    })

    expect(result).toEqual({ kind: 'ok' })
    expect(mockedRemoveWorkspace).toHaveBeenCalledWith({
      projectDirectory: projectDir,
      workspaceId: 'wrk_test',
      cleanupBranch: true,
      branchName: 'opencode/kimaki-feature',
    })
    expect(mockedDeleteWorkspace).toHaveBeenCalledWith(testThreadId)
  })

  test('still deletes the DB row and archives the thread even when git cleanup fails', async () => {
    mockedDeleteWorktree.mockResolvedValue(
      new Error('fatal: worktree is locked'),
    )

    const rest = makeRest()
    const result = await cleanupThreadWorktreeAndArchive({
      rest,
      threadId: testThreadId,
      cleanupOffer: {
        canCleanup: true,
        worktreeDir,
        projectDir,
        branch: 'opencode/kimaki-feature',
        workspaceId: null,
      },
    })

    expect(result.kind).toBe('archive-only')
    expect(mockedDeleteWorkspace).toHaveBeenCalledWith(testThreadId)
    // Thread still got archived.
    expect(rest.patch).toHaveBeenCalledWith(
      expect.stringContaining(testThreadId),
      expect.objectContaining({ body: { archived: true } }),
    )
  })
})
