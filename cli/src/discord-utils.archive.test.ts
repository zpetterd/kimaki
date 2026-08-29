// Stub-server tests for archiveOpenCodeSession verify-and-retry behavior.
//
// Pattern mirrors opencode-interrupt-plugin.test.ts: a tiny local HTTP server
// implements the three endpoints archiveOpenCodeSession calls, and the test
// drives a real OpencodeClient against it.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { archiveOpenCodeSession } from './discord-utils.js'

type AbortCall = { sessionID: string }
type UpdateCall = { sessionID: string; title?: string; time?: { archived?: number } }

// Tracks across the stub server's lifetime.
const updateCalls: UpdateCall[] = []
const abortCalls: AbortCall[] = []

function createStubServer(opts: { firstUpdateNoOp?: boolean; alwaysNoOp?: boolean } = {}) {
  const { firstUpdateNoOp = false, alwaysNoOp = false } = opts
  let firstUpdateDone = false
  const storedArchived = new Map<string, number>()

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => resolve(raw))
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // GET /session/{id}
    if (req.method === 'GET') {
      const getMatch = url.pathname.match(/^\/session\/([^/]+)$/)
      if (getMatch) {
        const sessionID = decodeURIComponent(getMatch[1]!)
        const archived = storedArchived.get(sessionID)
        sendJson(200, {
          id: sessionID,
          title: 'Test Session',
          time: archived !== undefined
            ? { created: Date.now(), updated: Date.now(), archived }
            : { created: Date.now(), updated: Date.now() },
        })
        return
      }
    }

    // PATCH /session/{id}
    if (req.method === 'PATCH') {
      const patchMatch = url.pathname.match(/^\/session\/([^/]+)$/)
      if (patchMatch) {
        const sessionID = decodeURIComponent(patchMatch[1]!)
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}

        // Simulate the silent-no-op server behavior when configured.
        const shouldNoOp = alwaysNoOp || (!firstUpdateDone && firstUpdateNoOp)
        if (!shouldNoOp) {
          if (body.time?.archived !== undefined) {
            storedArchived.set(sessionID, body.time.archived)
          }
        }
        firstUpdateDone = true

        updateCalls.push({ sessionID, title: body.title, time: body.time })
        sendJson(200, { success: true })
        return
      }
    }

    // POST /session/{id}/abort
    if (req.method === 'POST') {
      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
      if (abortMatch) {
        const sessionID = decodeURIComponent(abortMatch[1]!)
        abortCalls.push({ sessionID })
        sendJson(200, { success: true })
        return
      }
    }

    sendJson(404, { error: 'not found', path: url.pathname })
  })

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.close(() => done()) }),
      })
    })
  })
}

let stub: { baseUrl: string; close: () => Promise<void> }
let client: OpencodeClient

beforeEach(async () => {
  updateCalls.length = 0
  abortCalls.length = 0
  stub = await createStubServer()
  client = createOpencodeClient({ baseUrl: stub.baseUrl })
})

afterEach(async () => {
  await stub.close()
})

describe('archiveOpenCodeSession verify-and-retry', () => {
  test('happy path: session.update persists, abort is called, returns null', async () => {
    const sessionId = 'ses-happy'
    const result = await archiveOpenCodeSession({ client, sessionId, workingDirectory: undefined })

    expect(result).toBeNull()
    expect(updateCalls.some(c => c.sessionID === sessionId && typeof c.time?.archived === 'number')).toBe(true)
    expect(abortCalls).toEqual([{ sessionID: sessionId }])
  })

  test('retry-then-persist: first PATCH is a no-op, second persists, returns null', async () => {
    // Re-create stub with first-update-no-op behavior.
    await stub.close()
    updateCalls.length = 0
    abortCalls.length = 0
    stub = await createStubServer({ firstUpdateNoOp: true })
    client = createOpencodeClient({ baseUrl: stub.baseUrl })

    const sessionId = 'ses-retry'
    const result = await archiveOpenCodeSession({ client, sessionId, workingDirectory: undefined })

    expect(result).toBeNull()
    // First call was no-op, second call persisted.
    expect(updateCalls.filter(c => c.sessionID === sessionId).length).toBe(2)
    expect(abortCalls).toEqual([{ sessionID: sessionId }])
  })

  test('persistent no-op: PATCH never persists, returns Error, abort NOT called', async () => {
    // Re-create stub with always-no-op behavior.
    await stub.close()
    updateCalls.length = 0
    abortCalls.length = 0
    stub = await createStubServer({ alwaysNoOp: true })
    client = createOpencodeClient({ baseUrl: stub.baseUrl })

    const sessionId = 'ses-never-persists'
    const result = await archiveOpenCodeSession({ client, sessionId, workingDirectory: undefined })

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('time.archived not persisted')
    expect(abortCalls).toEqual([]) // abort must NOT be called when persistence fails
  })
})
