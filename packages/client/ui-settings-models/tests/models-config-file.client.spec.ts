/** Models configuration file: export assembly, parse refusals, and import planning. */
import { describe, expect, it } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MODELS_CONFIG_FORMAT, MODELS_CONFIG_VERSION, buildModelsConfigFile, isRecord, modelsConfigFilename,
  parseModelsConfigFile, partitionModelsConfigPlan, planModelsConfigImport, serializeModelsConfigFile,
  userProfileAt,
} from '../src/client/models-config-file.ts'
import type { ModelsConfigCandidate, ModelsConfigFile } from '../src/client/models-config-file.ts'

const NOW = new Date('2026-11-18T01:30:00.000Z')

function namespaceView(ns: string, user: JsonValue | undefined): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value: {},
    ...user === undefined ? {} : { user },
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

function candidate(overrides: Partial<ModelsConfigCandidate> = {}): ModelsConfigCandidate {
  return {
    provider: '9router',
    displayName: '9Router',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', '9router'],
    apiKeyEnv: 'NINEROUTER_API_KEY',
    credentialConfigured: true,
    ...overrides,
  }
}

/** The profile `candidate()` addresses inside the view built by {@link piAiNamespaces}. */
const NINE_ROUTER_PROFILE = {
  api: 'openai-completions',
  baseURL: 'http://172.16.10.21:20128/v1',
  apiKeyEnv: 'NINEROUTER_API_KEY',
  models: [{ id: 'combo', name: '9Router Combo' }],
}

function piAiNamespaces(): Map<string, SettingsNamespaceView> {
  return new Map([
    ['llm-pi-ai', namespaceView('llm-pi-ai', { providers: { '9router': NINE_ROUTER_PROFILE } })],
  ])
}

describe('userProfileAt', () => {
  it('reads the subtree the settings path addresses', () => {
    expect(userProfileAt(namespaceView('llm-pi-ai', { providers: { '9router': NINE_ROUTER_PROFILE } }),
      ['providers', '9router'])).toEqual(NINE_ROUTER_PROFILE)
  })

  it('treats an empty path as the whole section', () => {
    const section = { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api' }
    expect(userProfileAt(namespaceView('llm-deepseek', section), [])).toEqual(section)
  })

  it('returns undefined when the user layer or the addressed node is absent', () => {
    expect(userProfileAt(namespaceView('llm-pi-ai', undefined), ['providers', '9router'])).toBeUndefined()
    expect(userProfileAt(namespaceView('llm-pi-ai', { providers: {} }), ['providers', '9router'])).toBeUndefined()
    // A scalar where a profile belongs is not a profile.
    expect(userProfileAt(namespaceView('llm-pi-ai', { providers: { '9router': 7 } }), ['providers', '9router']))
      .toBeUndefined()
  })
})

describe('buildModelsConfigFile', () => {
  it('exports the user layer rather than the resolved value', () => {
    const built = buildModelsConfigFile([candidate()], piAiNamespaces(), '0.2.2-rc.4', NOW)
    if ('empty' in built) throw new Error('expected a document')
    expect(built.file.providers).toEqual([{
      provider: '9router',
      displayName: '9Router',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', '9router'],
      profile: NINE_ROUTER_PROFILE,
      apiKeyEnv: 'NINEROUTER_API_KEY',
      credentialConfigured: true,
    }])
    expect(built.file).toMatchObject({
      format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION, dshVersion: '0.2.2-rc.4',
    })
    expect(built.file.exportedAt).toBe(NOW.toISOString())
  })

  it('names no credential reference when the profile names none', () => {
    const keyless: ModelsConfigCandidate = {
      provider: '9router',
      displayName: '9Router',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', '9router'],
      credentialConfigured: false,
    }
    const built = buildModelsConfigFile([keyless], piAiNamespaces(), '0.2.2-rc.4', NOW)
    if ('empty' in built) throw new Error('expected a document')
    expect(built.file.providers[0]).not.toHaveProperty('apiKeyEnv')
    expect(built.file.providers[0]?.credentialConfigured).toBe(false)
  })

  it('skips a provider whose user layer is empty or absent', () => {
    const namespaces = new Map([
      ['llm-pi-ai', namespaceView('llm-pi-ai', { providers: { empty: {} } })],
    ])
    expect(buildModelsConfigFile([candidate({ settingsPath: ['providers', 'empty'] })], namespaces, 'v', NOW))
      .toEqual({ empty: true })
    expect(buildModelsConfigFile([candidate()], namespaces, 'v', NOW)).toEqual({ empty: true })
  })

  it('skips a provider whose namespace is not mounted', () => {
    expect(buildModelsConfigFile([candidate()], new Map(), 'v', NOW)).toEqual({ empty: true })
  })

  it('detaches the profile it exports', () => {
    const namespaces = piAiNamespaces()
    const built = buildModelsConfigFile([candidate()], namespaces, 'v', NOW)
    if ('empty' in built) throw new Error('expected a document')
    const user = namespaces.get('llm-pi-ai')?.user
    expect(built.file.providers[0]?.profile)
      .not.toBe(isRecord(user) ? (user as Record<string, JsonValue>).providers : undefined)
  })
})

describe('parseModelsConfigFile', () => {
  const valid = (): ModelsConfigFile => ({
    format: MODELS_CONFIG_FORMAT,
    version: MODELS_CONFIG_VERSION,
    exportedAt: NOW.toISOString(),
    dshVersion: '0.2.2-rc.4',
    providers: [{
      provider: '9router',
      displayName: '9Router',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', '9router'],
      profile: NINE_ROUTER_PROFILE,
      apiKeyEnv: 'NINEROUTER_API_KEY',
      credentialConfigured: true,
    }],
  })

  it('reads back what it wrote', () => {
    const parsed = parseModelsConfigFile(serializeModelsConfigFile(valid()))
    expect(parsed).toEqual({ kind: 'parsed', file: valid() })
  })

  it.each([
    ['not JSON at all', 'not-json'],
    ['[]', 'not-an-object'],
    ['null', 'not-an-object'],
  ])('refuses %s', (text, kind) => {
    const parsed = parseModelsConfigFile(text)
    expect(parsed.kind === 'refused' && parsed.failure.kind).toBe(kind)
  })

  it('refuses a document with no providers array', () => {
    const parsed = parseModelsConfigFile(JSON.stringify({
      format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION,
    }))
    expect(parsed.kind === 'refused' && parsed.failure).toEqual({ kind: 'not-an-object' })
  })

  it('refuses a document exported by another format', () => {
    const parsed = parseModelsConfigFile(JSON.stringify({ ...valid(), format: 'something-else' }))
    expect(parsed.kind === 'refused' && parsed.failure).toEqual({ kind: 'wrong-format' })
  })

  it('refuses a version this build does not read', () => {
    const parsed = parseModelsConfigFile(JSON.stringify({ ...valid(), version: 2 }))
    expect(parsed.kind === 'refused' && parsed.failure).toEqual({ kind: 'unsupported-version', version: 2 })
  })

  it.each([
    ['a provider without an id', { ...valid(), providers: [{ displayName: 'x', settingsNs: 'n', settingsPath: [], profile: {} }] }],
    ['a provider without a namespace', { ...valid(), providers: [{ provider: 'p', displayName: 'x', settingsPath: [], profile: {} }] }],
    ['a provider with a non-string path segment', { ...valid(), providers: [{ provider: 'p', displayName: 'x', settingsNs: 'n', settingsPath: [1], profile: {} }] }],
    ['a provider whose profile is an array', { ...valid(), providers: [{ provider: 'p', displayName: 'x', settingsNs: 'n', settingsPath: [], profile: [] }] }],
    ['a provider with a non-string credential reference', { ...valid(), providers: [{ provider: 'p', displayName: 'x', settingsNs: 'n', settingsPath: [], profile: {}, apiKeyEnv: 3 }] }],
  ])('refuses %s', (_label, document) => {
    const parsed = parseModelsConfigFile(JSON.stringify(document))
    expect(parsed.kind === 'refused' && parsed.failure.kind).toBe('malformed-provider')
  })

  it('names which provider entry is malformed', () => {
    const parsed = parseModelsConfigFile(JSON.stringify({
      ...valid(),
      providers: [valid().providers[0], { provider: 'broken' }],
    }))
    expect(parsed.kind === 'refused' && parsed.failure).toEqual({ kind: 'malformed-provider', index: 1 })
  })

  it('defaults the informational fields a foreign writer may omit', () => {
    const parsed = parseModelsConfigFile(JSON.stringify({
      format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION, providers: [],
    }))
    expect(parsed).toEqual({
      kind: 'parsed',
      file: {
        format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION, exportedAt: '', dshVersion: '', providers: [],
      },
    })
  })
})

describe('planModelsConfigImport', () => {
  const file = (): ModelsConfigFile => ({
    format: MODELS_CONFIG_FORMAT,
    version: MODELS_CONFIG_VERSION,
    exportedAt: NOW.toISOString(),
    dshVersion: '0.2.2-rc.4',
    providers: [
      {
        provider: '9router',
        displayName: '9Router',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', '9router'],
        profile: NINE_ROUTER_PROFILE,
        apiKeyEnv: 'NINEROUTER_API_KEY',
        credentialConfigured: true,
      },
      {
        provider: 'absent-here',
        displayName: 'Absent',
        settingsNs: 'llm-nowhere',
        settingsPath: [],
        profile: { a: 1 },
        credentialConfigured: false,
      },
    ],
  })

  it('reports mounting, replacement, and credential state per provider', () => {
    const plan = planModelsConfigImport(file(), piAiNamespaces(), new Set(['9router']),
      ref => ref === 'NINEROUTER_API_KEY')
    expect(plan).toEqual([
      {
        entry: file().providers[0],
        namespaceMounted: true,
        apiKeyEnv: 'NINEROUTER_API_KEY',
        credentialConfigured: true,
        replacesExisting: true,
      },
      {
        entry: file().providers[1],
        namespaceMounted: false,
        apiKeyEnv: undefined,
        credentialConfigured: false,
        replacesExisting: false,
      },
    ])
  })

  it('reports an absent credential as not configured', () => {
    const plan = planModelsConfigImport(file(), piAiNamespaces(), new Set(), () => false)
    expect(plan[0]?.credentialConfigured).toBe(false)
  })

  it('splits the plan into writable and skipped entries without reordering', () => {
    const plan = planModelsConfigImport(file(), piAiNamespaces(), new Set(), () => false)
    const split = partitionModelsConfigPlan(plan)
    expect(split.writable.map(item => item.entry.provider)).toEqual(['9router'])
    expect(split.skipped.map(item => item.entry.provider)).toEqual(['absent-here'])
  })
})

describe('download naming', () => {
  it('names the file after the export date', () => {
    expect(modelsConfigFilename(NOW)).toBe('dsh-models-2026-11-18.json')
  })

  it('ends the serialized document in exactly one newline', () => {
    const text = serializeModelsConfigFile({
      format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION,
      exportedAt: NOW.toISOString(), dshVersion: 'v', providers: [],
    })
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})
