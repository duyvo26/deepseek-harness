/**
 * The Models configuration file: the browser-side document that carries every
 * configured provider profile between machines.
 *
 * The file holds user-layer settings only. A resolved namespace value merges
 * schema defaults, the composition base layer, and the user layer, so exporting
 * it would replay inherited fields as if the user had typed them; export reads
 * `namespace.user` instead. Credentials never appear: the Host returns masked
 * previews only, so the file names each reference and lets the importing page
 * report which ones still need a value.
 *
 * @module models-config-file
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** File-format identifier. A reader rejects any other value. */
export const MODELS_CONFIG_FORMAT = 'dsh.models-config'

/** The only file-format version this build reads and writes. */
export const MODELS_CONFIG_VERSION = 1

/** One provider profile as the file carries it. */
export interface ModelsConfigEntry {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name, for the import preview only. */
  displayName: string
  /** Settings namespace whose section stores this profile. */
  settingsNs: string
  /** Path from that namespace's section root to the profile object. */
  settingsPath: string[]
  /** The user layer at {@link settingsPath}; what import writes back. */
  profile: Record<string, JsonValue>
  /** Credential reference the profile names; import reports what is missing. */
  apiKeyEnv?: string
  /** Whether the exporting machine had a value stored for {@link apiKeyEnv}. */
  credentialConfigured: boolean
}

/** The document written by Export and read by Import. */
export interface ModelsConfigFile {
  format: typeof MODELS_CONFIG_FORMAT
  version: number
  /** Export time, ISO 8601; informational only. */
  exportedAt: string
  /** dsh release the exporting build ran, compared on import. */
  dshVersion: string
  providers: ModelsConfigEntry[]
}

/** A provider to export: its identity plus the namespace view that owns it. */
export interface ModelsConfigCandidate {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  /** Credential reference the resolved profile names, when it names one. */
  apiKeyEnv?: string
  /** Whether that reference currently has a value. */
  credentialConfigured: boolean
}

/**
 * Whether a value is a JSON object rather than an array or null.
 * @param value - candidate value.
 * @returns whether the value is a plain record.
 */
export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the user-layer profile one candidate addresses.
 *
 * An empty {@link ModelsConfigCandidate.settingsPath} means the whole namespace
 * section is the profile, which is how a whole-section provider is stored.
 * @param namespace - the namespace view holding the user layer.
 * @param path - path from the section root to the profile object.
 * @returns the stored user subtree, or undefined when the user configured nothing there.
 */
export function userProfileAt(
  namespace: SettingsNamespaceView,
  path: readonly string[],
): Record<string, JsonValue> | undefined {
  let node: unknown = namespace.user
  for (const segment of path) {
    if (!isRecord(node)) return undefined
    node = node[segment]
  }
  if (!isRecord(node)) return undefined
  return node
}

/**
 * Build the export document from the providers the page joined with their
 * namespaces.
 *
 * Candidates whose user layer is empty are skipped: a dormant directory row and
 * a provider left on inherited defaults both carry nothing to move, and writing
 * an empty object back would materialize a profile the user never made.
 * @param candidates - providers the page offers, already credential-joined.
 * @param namespaces - namespace views by ns, as the page snapshot holds them.
 * @param dshVersion - release running this build.
 * @param now - export timestamp, injected so tests do not read the clock.
 * @returns the document, or the reason nothing could be exported.
 */
export function buildModelsConfigFile(
  candidates: readonly ModelsConfigCandidate[],
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
  dshVersion: string,
  now: Date,
): { file: ModelsConfigFile } | { empty: true } {
  const providers: ModelsConfigEntry[] = []
  for (const candidate of candidates) {
    const namespace = namespaces.get(candidate.settingsNs)
    if (namespace === undefined) continue
    const profile = userProfileAt(namespace, candidate.settingsPath)
    if (profile === undefined || Object.keys(profile).length === 0) continue
    providers.push({
      provider: candidate.provider,
      displayName: candidate.displayName,
      settingsNs: candidate.settingsNs,
      settingsPath: [...candidate.settingsPath],
      // Detached: the caller keeps rendering from the namespace it handed in.
      profile: structuredClone(profile),
      ...candidate.apiKeyEnv === undefined ? {} : { apiKeyEnv: candidate.apiKeyEnv },
      credentialConfigured: candidate.credentialConfigured,
    })
  }
  if (providers.length === 0) return { empty: true }
  return {
    file: {
      format: MODELS_CONFIG_FORMAT,
      version: MODELS_CONFIG_VERSION,
      exportedAt: now.toISOString(),
      dshVersion,
      providers,
    },
  }
}

/** Why a parsed document was refused. */
export type ModelsConfigParseFailure =
  | { kind: 'not-json' }
  | { kind: 'not-an-object' }
  | { kind: 'wrong-format' }
  | { kind: 'unsupported-version'; version: number }
  | { kind: 'malformed-provider'; index: number }

/** Outcome of reading a document the user chose. */
export type ModelsConfigParseOutcome =
  | { kind: 'parsed'; file: ModelsConfigFile }
  | { kind: 'refused'; failure: ModelsConfigParseFailure }

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function readEntry(value: unknown, index: number): ModelsConfigEntry | ModelsConfigParseFailure {
  const malformed: ModelsConfigParseFailure = { kind: 'malformed-provider', index }
  if (!isRecord(value)) return malformed
  const { provider, displayName, settingsNs, settingsPath, profile } = value
  if (typeof provider !== 'string' || provider.length === 0) return malformed
  if (typeof displayName !== 'string') return malformed
  if (typeof settingsNs !== 'string' || settingsNs.length === 0) return malformed
  if (!isStringArray(settingsPath)) return malformed
  if (!isRecord(profile)) return malformed
  const apiKeyEnv = value.apiKeyEnv
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') return malformed
  return {
    provider,
    displayName,
    settingsNs,
    settingsPath: [...settingsPath],
    profile: structuredClone(profile),
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    credentialConfigured: value.credentialConfigured === true,
  }
}

/**
 * Read a document the user selected. Every refusal names what to fix, because
 * the caller renders it without a Host diagnostic to fall back on.
 * @param text - file contents.
 * @returns the parsed document, or the refusal.
 */
export function parseModelsConfigFile(text: string): ModelsConfigParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // JSON.parse throws SyntaxError on any malformed input; the caller reports it as a wording issue.
    return { kind: 'refused', failure: { kind: 'not-json' } }
  }
  if (!isRecord(raw)) return { kind: 'refused', failure: { kind: 'not-an-object' } }
  if (raw.format !== MODELS_CONFIG_FORMAT) return { kind: 'refused', failure: { kind: 'wrong-format' } }
  if (raw.version !== MODELS_CONFIG_VERSION) {
    const version = typeof raw.version === 'number' ? raw.version : Number.NaN
    return { kind: 'refused', failure: { kind: 'unsupported-version', version } }
  }
  if (!Array.isArray(raw.providers)) return { kind: 'refused', failure: { kind: 'not-an-object' } }
  const providers: ModelsConfigEntry[] = []
  for (const [index, candidate] of raw.providers.entries()) {
    const entry = readEntry(candidate, index)
    if ('kind' in entry) return { kind: 'refused', failure: entry }
    providers.push(entry)
  }
  return {
    kind: 'parsed',
    file: {
      format: MODELS_CONFIG_FORMAT,
      version: MODELS_CONFIG_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      dshVersion: typeof raw.dshVersion === 'string' ? raw.dshVersion : '',
      providers,
    },
  }
}

/**
 * Serialize a document for download.
 * @param file - document to write.
 * @returns pretty-printed JSON ending in one newline.
 */
export function serializeModelsConfigFile(file: ModelsConfigFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * The browser download filename for one export.
 * @param now - export timestamp, injected so tests do not read the clock.
 * @returns a filename naming the format and its date.
 */
export function modelsConfigFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 10)
  return `dsh-models-${stamp}.json`
}

/**
 * One provider the import would write, and what the page must restore by hand.
 */
export interface ModelsConfigImportPlanEntry {
  readonly entry: ModelsConfigEntry
  /** Whether this page has the namespace mounted, so the write can land. */
  readonly namespaceMounted: boolean
  /** Credential reference the imported profile names, when it names one. */
  readonly apiKeyEnv: string | undefined
  /** Whether this machine already has a value for that reference. */
  readonly credentialConfigured: boolean
  /** Whether a provider already exists under this route id, so the write replaces it. */
  readonly replacesExisting: boolean
}

/**
 * Decide what one import would do, without writing anything.
 *
 * A provider whose namespace is not mounted cannot be written: the file came
 * from a build that mounted an adapter this one does not, and silently writing
 * into an unmounted namespace would report success for a profile nothing reads.
 * @param file - parsed document.
 * @param namespaces - namespace views by ns for the current page.
 * @param existing - provider route ids currently configured on this page.
 * @param credentialConfigured - whether a reference currently has a value.
 * @returns one entry per provider in the file, in file order.
 */
export function planModelsConfigImport(
  file: ModelsConfigFile,
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
  existing: ReadonlySet<string>,
  credentialConfigured: (ref: string) => boolean,
): ModelsConfigImportPlanEntry[] {
  return file.providers.map(entry => ({
    entry,
    namespaceMounted: namespaces.has(entry.settingsNs),
    apiKeyEnv: entry.apiKeyEnv,
    credentialConfigured: entry.apiKeyEnv === undefined ? false : credentialConfigured(entry.apiKeyEnv),
    replacesExisting: existing.has(entry.provider),
  }))
}

/**
 * Split a plan into what can be written and what the user must fix first.
 * @param plan - entries from {@link planModelsConfigImport}.
 * @returns the writable entries and the skipped ones, each in file order.
 */
export function partitionModelsConfigPlan(
  plan: readonly ModelsConfigImportPlanEntry[],
): { writable: ModelsConfigImportPlanEntry[]; skipped: ModelsConfigImportPlanEntry[] } {
  const writable: ModelsConfigImportPlanEntry[] = []
  const skipped: ModelsConfigImportPlanEntry[] = []
  for (const item of plan) (item.namespaceMounted ? writable : skipped).push(item)
  return { writable, skipped }
}
