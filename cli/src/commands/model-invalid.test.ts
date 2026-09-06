// Tests for stale-model invalid detection in getCurrentModelInfo and
// ensureSessionPreferencesSnapshot. When a stored providerID/modelID no longer
// resolves in the live provider list, the resolution must surface an `invalid`
// variant (not silently return the dead model) so callers can clean up.
//
// Uses direct libsql access (no Hrana) to avoid shared process state with
// other test files that spin up the Hrana server.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, getDb } from '../db.js'
import { setDataDir } from '../config.js'
import * as schema from '../schema.js'
import {
  setSessionModel,
  setChannelModel,
  setGlobalModel,
  setBotToken,
  setChannelDirectory,
  clearChannelModel,
  getSessionModel,
  getChannelModel,
} from '../database.js'
import { ensureSessionPreferencesSnapshot, getCurrentModelInfo } from './model.js'
import type { initializeOpencodeForDirectory } from '../opencode.js'

type GetClient = Awaited<ReturnType<typeof initializeOpencodeForDirectory>>

const CHANNEL_ID = '200000000009900001'
const SESSION_ID = 'ses_test_stale_model_001'
const APP_ID = '200000000009900002'

// Mock client only implements the surface used by getCurrentModelInfo + ensureSessionPreferencesSnapshot:
// - provider.list: returns the connected list + all providers with their model catalog
// - app.agents: returns the configured agents (used by agent-model layer)
// - config.get: returns the project opencode config
function makeMockClient({
  connected,
  providers,
  agents = [],
  configModel,
}: {
  connected: string[]
  providers: Array<{ id: string; models?: Record<string, unknown> }>
  agents?: Array<{ name: string; model?: { providerID: string; modelID: string } }>
  configModel?: string
}): GetClient {
  return (() => {
    return {
      provider: {
        async list() {
          return {
            data: {
              connected,
              default: Object.fromEntries(
                connected.map((id) => {
                  const provider = providers.find((p) => p.id === id)
                  const modelEntries = provider?.models
                    ? Object.keys(provider.models)
                    : []
                  return [id, modelEntries[0] ?? '']
                }),
              ),
              all: providers,
            },
          }
        },
      },
      app: {
        async agents() {
          return { data: agents }
        },
      },
      config: {
        async get() {
          return { data: configModel ? { model: configModel } : {} }
        },
      },
    }
  }) as unknown as GetClient
}

describe('stale-model invalid detection', () => {
  let dataDir = ''
  let prevDbUrl: string | undefined
  let prevDataDir: string | undefined

  beforeAll(async () => {
    await closeDb()
    // Use a temp data dir so we don't share state with the global singleton.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-stale-model-'))
    prevDataDir = process.env['KIMAKI_DATA_DIR']
    setDataDir(dataDir)
    prevDbUrl = process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_DB_URL']

    // Reinitialize against the new data dir.
    await closeDb()
    const db = await getDb()

    await db.delete(schema.session_models)
    await db.delete(schema.channel_models)
    await db.delete(schema.global_models)
    await db.delete(schema.bot_tokens)
    await db.delete(schema.channel_directories)

    // Seed FK parents so channel_models / global_models inserts pass.
    await setBotToken(APP_ID, 'test-bot-token')
    await setChannelDirectory({
      channelId: CHANNEL_ID,
      directory: '/tmp/test-project',
      channelType: 'text',
    })
  })

  afterAll(async () => {
    await closeDb()
    if (prevDataDir === undefined) {
      delete process.env['KIMAKI_DATA_DIR']
    } else {
      process.env['KIMAKI_DATA_DIR'] = prevDataDir
    }
    if (prevDbUrl === undefined) {
      delete process.env['KIMAKI_DB_URL']
    } else {
      process.env['KIMAKI_DB_URL'] = prevDbUrl
    }
    if (dataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })

  test('returns invalid type when session preference points to dead model', async () => {
    const getClient = makeMockClient({
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    await setSessionModel({
      sessionId: SESSION_ID,
      modelId: 'deepseek/deepseek-coder',
    })

    const result = await getCurrentModelInfo({
      sessionId: SESSION_ID,
      getClient,
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    expect(result.type).toBe('invalid')
    if (result.type === 'invalid') {
      expect(result.model).toBe('deepseek/deepseek-coder')
      expect(result.providerID).toBe('deepseek')
      expect(result.modelID).toBe('deepseek-coder')
    }
  })

  test('surfaces invalid when channel preference is invalid', async () => {
    const getClient = makeMockClient({
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    await setChannelModel({
      channelId: CHANNEL_ID,
      modelId: 'deepseek/deepseek-coder',
    })
    await setGlobalModel({
      appId: APP_ID,
      modelId: 'anthropic/claude-opus-4-6',
    })

    const result = await getCurrentModelInfo({
      channelId: CHANNEL_ID,
      appId: APP_ID,
      getClient,
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    // Validation runs against each layer in order: no session, no agent,
    // channel is invalid — surface as invalid so callers (UI / dispatch) can
    // react. We do not silently fall through; that would mask stale state.
    expect(result.type).toBe('invalid')
    if (result.type === 'invalid') {
      expect(result.model).toBe('deepseek/deepseek-coder')
    }
  })

  test('returns regular session variant when validation is not requested', async () => {
    const getClient = makeMockClient({
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    await setSessionModel({
      sessionId: SESSION_ID,
      modelId: 'deepseek/deepseek-coder',
    })

    const result = await getCurrentModelInfo({
      sessionId: SESSION_ID,
      getClient,
    })

    expect(result.type).toBe('session')
    if (result.type === 'session') {
      expect(result.model).toBe('deepseek/deepseek-coder')
    }
  })

  test('ensureSessionPreferencesSnapshot evicts dead model and re-bootstraps to a valid one', async () => {
    const getClient = makeMockClient({
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    await setSessionModel({
      sessionId: SESSION_ID,
      modelId: 'deepseek/deepseek-coder',
    })

    await ensureSessionPreferencesSnapshot({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      appId: APP_ID,
      getClient,
      directory: '/tmp',
    })

    const after = await getSessionModel(SESSION_ID)
    // The stale `deepseek/deepseek-coder` must be gone — either the row is
    // deleted (no fallback available) or rewritten to a valid model.
    expect(after?.modelId).not.toBe('deepseek/deepseek-coder')
  })

  test('ensureSessionPreferencesSnapshot keeps valid session preferences', async () => {
    const getClient = makeMockClient({
      connected: ['anthropic'],
      providers: [{ id: 'anthropic', models: { 'claude-opus-4-6': {} } }],
    })

    await setSessionModel({
      sessionId: SESSION_ID,
      modelId: 'anthropic/claude-opus-4-6',
    })

    await ensureSessionPreferencesSnapshot({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      appId: APP_ID,
      getClient,
      directory: '/tmp',
    })

    const after = await getSessionModel(SESSION_ID)
    expect(after?.modelId).toBe('anthropic/claude-opus-4-6')
  })

  test('clearChannelModel removes the channel row', async () => {
    await setChannelModel({
      channelId: CHANNEL_ID,
      modelId: 'anthropic/claude-opus-4-6',
    })
    expect((await getChannelModel(CHANNEL_ID))?.modelId).toBe('anthropic/claude-opus-4-6')

    await clearChannelModel(CHANNEL_ID)

    expect(await getChannelModel(CHANNEL_ID)).toBeUndefined()
  })
})
