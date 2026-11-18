// @vitest-environment jsdom
/** Export/import controls: download wiring, refusal surfaces, and the confirmation write. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsConfigIo } from '../src/client/ModelsConfigIo.tsx'
import type { ExportableProvider } from '../src/client/ModelsConfigIo.tsx'
import type { ModelsOperations, SettingsWriteOutcome } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { MODELS_CONFIG_FORMAT, MODELS_CONFIG_VERSION } from '../src/client/models-config-file.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = (key: keyof typeof en): string => en[key]

const PROFILE = { api: 'openai-completions', baseURL: 'https://gateway.example/v1' }

function namespaceView(ns: string, user: JsonValue | undefined): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value: {},
    ...user === undefined ? {} : { user },
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 3,
  }
}

function namespaces(): Map<string, SettingsNamespaceView> {
  return new Map([
    ['llm-pi-ai', namespaceView('llm-pi-ai', { providers: { gateway: PROFILE } })],
  ])
}

function provider(overrides: Partial<ExportableProvider> = {}): ExportableProvider {
  return {
    provider: 'gateway',
    displayName: 'Gateway',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'gateway'],
    apiKeyEnv: 'GATEWAY_API_KEY',
    credentialConfigured: true,
    ...overrides,
  }
}

function operations(write?: (ns: string, ops: unknown) => Promise<SettingsWriteOutcome>): ModelsOperations {
  return {
    storeCredential: () => Promise.resolve(undefined),
    removeCredential: () => Promise.resolve(undefined),
    writeSettings: write ?? (() => Promise.resolve({ kind: 'written', view: namespaceView('llm-pi-ai', {}) })),
    discoverModels: () => Promise.resolve({ kind: 'found', models: [] }),
  }
}

/** Capture the text an export hands the download manager. */
function captureDownload(): { text: () => string } {
  let captured = ''
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    // jsdom keeps Blob bytes out of reach synchronously; read them back through the reader API below.
    void (blob as Blob).text().then((value) => { captured = value })
    return 'blob:mock'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { text: () => captured }
}

/** Read the file the picker would deliver and hand it to the input. */
function pickFile(container: HTMLElement, contents: string, name = 'models.json'): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('no file input rendered')
  const file = new File([contents], name, { type: 'application/json' })
  // jsdom's File carries text(); the component only reads it.
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

describe('export', () => {
  it('downloads the configured providers as a JSON document', async () => {
    const download = captureDownload()
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations()}
        reload={() => Promise.resolve()} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.configExport }))
    await waitFor(() => { expect(download.text()).not.toBe('') })
    const document = JSON.parse(download.text()) as Record<string, unknown>
    expect(document.format).toBe(MODELS_CONFIG_FORMAT)
    expect(document.version).toBe(MODELS_CONFIG_VERSION)
    expect(document.providers).toEqual([{
      provider: 'gateway',
      displayName: 'Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'gateway'],
      profile: PROFILE,
      apiKeyEnv: 'GATEWAY_API_KEY',
      credentialConfigured: true,
    }])
    expect(screen.getByRole('status').textContent).toBe(en.configExportSaved)
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1)
  })

  it('explains that there is nothing to export yet', () => {
    const download = captureDownload()
    render(
      <ModelsConfigIo providers={[]} namespaces={new Map()} operations={operations()}
        reload={() => Promise.resolve()} t={t} />,
    )
    const button = screen.getByRole('button', { name: en.configExport })
    expect(button).toHaveProperty('disabled', true)
    expect(download.text()).toBe('')
  })

  it('reports an empty document when no provider carries a user layer', () => {
    render(
      <ModelsConfigIo providers={[provider()]} namespaces={new Map()} operations={operations()}
        reload={() => Promise.resolve()} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.configExport }))
    expect(screen.getByRole('status').textContent).toBe(en.configExportEmpty)
  })
})

describe('import', () => {
  const file = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    format: MODELS_CONFIG_FORMAT,
    version: MODELS_CONFIG_VERSION,
    exportedAt: '2026-11-18T00:00:00.000Z',
    dshVersion: '0.2.2-rc.4',
    providers: [{
      provider: 'gateway',
      displayName: 'Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'gateway'],
      profile: PROFILE,
      apiKeyEnv: 'GATEWAY_API_KEY',
      credentialConfigured: true,
    }],
    ...overrides,
  })

  it('writes the profile only after the user confirms', async () => {
    const write = vi.fn(() => Promise.resolve<SettingsWriteOutcome>({
      kind: 'written', view: namespaceView('llm-pi-ai', {}),
    }))
    const reload = vi.fn(() => Promise.resolve())
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations(write)}
        reload={reload} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Gateway')
    expect(write).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.configImportApply }))
    })
    expect(write).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'gateway'], value: PROFILE }],
      undefined,
    )
    expect(reload).toHaveBeenCalled()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en.configImportDone) })
  })

  it('marks a provider the import replaces', async () => {
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations()}
        reload={() => Promise.resolve()} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })
    expect((await screen.findByRole('dialog')).textContent).toContain(en.configImportReplaces)
  })

  it('names a credential the importing machine still needs', async () => {
    const { container } = render(
      <ModelsConfigIo providers={[provider({ credentialConfigured: false })]} namespaces={namespaces()}
        operations={operations()} reload={() => Promise.resolve()} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })
    const text = (await screen.findByRole('dialog')).textContent ?? ''
    expect(text).toContain('GATEWAY_API_KEY')
    expect(text).toContain(en.configImportMissingKeys)
  })

  it('skips a provider whose namespace this build does not mount', async () => {
    const write = vi.fn(() => Promise.resolve<SettingsWriteOutcome>({
      kind: 'written', view: namespaceView('llm-pi-ai', {}),
    }))
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={new Map()} operations={operations(write)}
        reload={() => Promise.resolve()} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en.configImportSkipped.replace('{providers}', 'Gateway'))
    // Nothing writable means nothing to apply.
    expect(screen.getByRole('button', { name: en.configImportApply })).toHaveProperty('disabled', true)
  })

  it.each([
    ['not JSON at all', en.configImportNotJson],
    ['[]', en.configImportNotObject],
    [JSON.stringify({ format: 'other', version: 1, providers: [] }), en.configImportWrongFormat],
    [JSON.stringify({ format: MODELS_CONFIG_FORMAT, version: 99, providers: [] }), en.configImportUnsupportedVersion],
    [JSON.stringify({ format: MODELS_CONFIG_FORMAT, version: MODELS_CONFIG_VERSION, providers: [{ provider: 'x' }] }),
      en.configImportMalformed],
  ])('refuses %s', async (contents, message) => {
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations()}
        reload={() => Promise.resolve()} t={t} />,
    )
    await act(async () => { pickFile(container, contents) })
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it('reports a refused write and keeps the dialog open', async () => {
    const write = () => Promise.resolve<SettingsWriteOutcome>({ kind: 'conflict', message: 'stale' })
    const reload = vi.fn(() => Promise.resolve())
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations(write)}
        reload={reload} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.configImportApply }))
    })
    expect((await screen.findByRole('alert')).textContent).toBe('stale')
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes without writing when the user cancels', async () => {
    const write = vi.fn(() => Promise.resolve<SettingsWriteOutcome>({
      kind: 'written', view: namespaceView('llm-pi-ai', {}),
    }))
    const { container } = render(
      <ModelsConfigIo providers={[provider()]} namespaces={namespaces()} operations={operations(write)}
        reload={() => Promise.resolve()} t={t} />,
    )
    await act(async () => { pickFile(container, file()) })
    await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('renders nothing before the shell injects', () => {
    const { container } = render(<ModelsConfigIo />)
    expect(container.firstChild).toBeNull()
  })
})
