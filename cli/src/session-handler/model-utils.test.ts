// Tests for model-utils helpers: parseModelString + isModelValid.
// These are pure functions so they need no fixture setup.

import { describe, expect, test } from 'vitest'
import { isModelValid, parseModelString } from './model-utils.js'

describe('parseModelString', () => {
  test('splits simple "provider/model" into two parts', () => {
    expect(parseModelString('anthropic/claude-opus-4-6')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6',
    })
  })

  test('preserves model IDs that contain slashes', () => {
    expect(parseModelString('openai/gpt-5/codex')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5/codex',
    })
  })

  test('returns undefined when the string is empty or missing parts', () => {
    expect(parseModelString('')).toBeUndefined()
    expect(parseModelString('anthropic')).toBeUndefined()
    expect(parseModelString('/claude')).toBeUndefined()
  })
})

describe('isModelValid', () => {
  const providers = [
    {
      id: 'anthropic',
      models: {
        'claude-opus-4-6': {},
        'claude-sonnet-4-6': {},
      },
    },
    {
      id: 'deepseek',
      models: {
        'deepseek-coder': {},
      },
    },
  ]

  test('returns true when provider is connected and model exists', () => {
    expect(
      isModelValid(
        { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
        ['anthropic'],
        providers,
      ),
    ).toBe(true)
  })

  test('returns false when provider is not connected', () => {
    expect(
      isModelValid(
        { providerID: 'deepseek', modelID: 'deepseek-coder' },
        ['anthropic'],
        providers,
      ),
    ).toBe(false)
  })

  test('returns false when model ID is missing from provider catalog', () => {
    expect(
      isModelValid(
        { providerID: 'anthropic', modelID: 'gpt-99-missing' },
        ['anthropic'],
        providers,
      ),
    ).toBe(false)
  })

  test('returns false when provider has no models map', () => {
    expect(
      isModelValid(
        { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
        ['anthropic'],
        [{ id: 'anthropic' }],
      ),
    ).toBe(false)
  })
})
