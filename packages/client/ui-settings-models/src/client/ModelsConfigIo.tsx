/**
 * Export and import of the Models configuration file.
 *
 * Two buttons below the provider rows. Export writes a JSON document naming
 * every configured provider's user-layer profile; import reads one back, shows
 * what it would change, and writes only after the user confirms. Credentials
 * stay out of the file in both directions — the Host never returns a stored
 * secret — so the import summary names the references this machine still has to
 * fill in.
 *
 * @module ModelsConfigIo
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconDownloadOutlineRegular, IconUploadOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import {
  buildModelsConfigFile, modelsConfigFilename, parseModelsConfigFile, partitionModelsConfigPlan,
  planModelsConfigImport, serializeModelsConfigFile,
} from './models-config-file.ts'
import type {
  ModelsConfigFile, ModelsConfigImportPlanEntry, ModelsConfigParseFailure,
} from './models-config-file.ts'
import styles from './ModelsSection.module.css'

/** One provider the page can export, as the section joins it. */
export interface ExportableProvider {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly apiKeyEnv?: string
  readonly credentialConfigured: boolean
}

/** Injected dependencies of {@link ModelsConfigIo}. */
export interface ModelsConfigIoInjected {
  /** Providers with a namespace the page resolved, in page order. */
  providers: readonly ExportableProvider[]
  /** Namespace views by ns, for the user layers export reads. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** The page's Host operations (settings writes). */
  operations: ModelsOperations
  /** Reload the page snapshot after a successful import. */
  reload: () => Promise<void>
  /** Copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered at the render site: the injected face spread flat. */
export type ModelsConfigIoProps = Partial<ModelsConfigIoInjected>

/** One addressable failure the import surface reports. */
interface ImportFailure {
  /** Localized sentence explaining what to fix. */
  readonly message: string
}

/**
 * Hand a serialized document to the browser download manager.
 *
 * The anchor carries an object URL rather than a Host route: the document is
 * assembled in the browser from data the page already read, so no Host
 * endpoint owns its bytes.
 * @param filename - suggested save name.
 * @param text - document contents.
 */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoked on the next task so the click above keeps a live URL.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/**
 * Render the export/import controls and the import confirmation dialog.
 * @param props - injected dependencies.
 * @returns the controls, or null while the shell has not injected yet.
 */
export function ModelsConfigIo(props: ModelsConfigIoProps): ReactNode {
  const { providers, namespaces, operations, reload, t } = props
  if (providers === undefined || namespaces === undefined || operations === undefined
    || reload === undefined || t === undefined) return null
  return (
    <Loaded
      injected={{ providers, namespaces, operations, reload, t }}
    />
  )
}

function Loaded({ injected }: { injected: ModelsConfigIoInjected }): ReactNode {
  const { providers, namespaces, operations, reload, t } = injected
  /** The parsed document awaiting confirmation; undefined while no dialog is open. */
  const [pending, setPending] = useState<ModelsConfigFile | undefined>(undefined)
  const [planned, setPlanned] = useState<readonly ModelsConfigImportPlanEntry[]>([])
  const [failure, setFailure] = useState<ImportFailure | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const closeDialog = (): void => {
    if (applying) return
    setPending(undefined)
    setPlanned([])
    setFailure(undefined)
  }

  const exportNow = (): void => {
    setNotice(undefined)
    const now = new Date()
    const built = buildModelsConfigFile(
      providers,
      namespaces,
      process.env.DSH_CLIENT_VERSION ?? '',
      now,
    )
    if ('empty' in built) {
      setNotice(t('configExportEmpty'))
      return
    }
    downloadText(modelsConfigFilename(now), serializeModelsConfigFile(built.file))
    setNotice(t('configExportSaved'))
  }

  const readFile = async (file: File): Promise<void> => {
    setNotice(undefined)
    const parsed = parseModelsConfigFile(await file.text())
    if (parsed.kind === 'refused') {
      setPending(undefined)
      setPlanned([])
      setFailure({ message: t(failureKey(parsed.failure)) })
      return
    }
    const configured = new Set(providers.filter(provider => provider.credentialConfigured)
      .flatMap(provider => provider.apiKeyEnv === undefined ? [] : [provider.apiKeyEnv]))
    const plan = planModelsConfigImport(parsed.file, namespaces, new Set(
      providers.map(provider => provider.provider),
    ), ref => configured.has(ref))
    setPending(parsed.file)
    setPlanned(plan)
    setFailure(undefined)
  }

  const applyImport = async (): Promise<void> => {
    if (pending === undefined) return
    setApplying(true)
    let refused: string | undefined
    for (const item of partitionModelsConfigPlan(planned).writable) {
      const written = await operations.writeSettings(
        item.entry.settingsNs,
        [{ op: 'set', path: [...item.entry.settingsPath], value: item.entry.profile }],
        undefined,
      )
      if (written.kind !== 'written') {
        refused = written.message
        break
      }
    }
    setApplying(false)
    if (refused !== undefined) {
      setFailure({ message: refused })
      return
    }
    setPending(undefined)
    setPlanned([])
    await reload()
    setNotice(t('configImportDone'))
  }

  const { writable, skipped } = partitionModelsConfigPlan(planned)
  const missingKeys = writable
    .filter(item => item.apiKeyEnv !== undefined && !item.credentialConfigured)
    .flatMap(item => item.apiKeyEnv === undefined ? [] : [item.apiKeyEnv])

  return (
    <div className={styles['configIo']}>
      <div className={styles['configIoActions']}>
        <Button
          variant="outline"
          icon={<IconDownloadOutlineRegular size={14} />}
          onClick={exportNow}
          disabled={providers.length === 0}
        >
          {t('configExport')}
        </Button>
        <Button
          variant="outline"
          icon={<IconUploadOutlineRegular size={14} />}
          onClick={() => {
            setFailure(undefined)
            setNotice(undefined)
            fileInput.current?.click()
          }}
        >
          {t('configImport')}
        </Button>
        {/* Driven by the button above, so it carries no label of its own and
            stays out of the accessibility tree and the tab order. */}
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className={styles['configIoFile']}
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Clear so re-picking the same file fires a change event again.
            event.target.value = ''
            if (file === undefined) return
            void readFile(file)
          }}
        />
      </div>
      {notice === undefined ? null : <p className={styles['configIoNotice']} role="status">{notice}</p>}
      <Modal
        open={pending !== undefined || failure !== undefined}
        onClose={closeDialog}
        title={t('configImportTitle')}
        closeLabel={t('close')}
        description={pending === undefined ? t('configImportFailureTitle') : t('configImportDescription')}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus disabled={applying} onClick={closeDialog}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={applying || pending === undefined || writable.length === 0}
              onClick={() => { void applyImport() }}
            >
              {applying ? t('applying') : t('configImportApply')}
            </Button>
          </>
        )}
      >
        {failure === undefined ? null : <p className={styles['error']} role="alert">{failure.message}</p>}
        {writable.length === 0
          ? null
          : (
            <ul className={styles['configIoList']}>
              {writable.map(item => (
                <li key={item.entry.provider} className={styles['configIoItem']}>
                  <span className={styles['configIoName']}>{item.entry.displayName}</span>
                  {item.replacesExisting
                    ? <span className={styles['configIoTag']}>{t('configImportReplaces')}</span>
                    : null}
                  {item.apiKeyEnv === undefined
                    ? null
                    : (
                      <span className={styles['configIoMeta']}>
                        {item.credentialConfigured
                          ? t('configImportKeyPresent')
                          : t('configImportKeyMissing').replace('{ref}', item.apiKeyEnv)}
                      </span>
                    )}
                </li>
              ))}
            </ul>
          )}
        {skipped.length === 0
          ? null
          : (
            <p className={styles['notice']}>
              {t('configImportSkipped').replace('{providers}', skipped
                .map(item => item.entry.displayName).join(', '))}
            </p>
          )}
        {missingKeys.length === 0
          ? null
          : <p className={styles['notice']}>{t('configImportMissingKeys')}</p>}
      </Modal>
    </div>
  )
}

/**
 * The copy key naming one parse refusal.
 * @param failure - refusal discriminant from the parser.
 * @returns the locale key whose text explains it.
 */
function failureKey(failure: ModelsConfigParseFailure): keyof typeof en {
  switch (failure.kind) {
    case 'not-json': return 'configImportNotJson'
    case 'not-an-object': return 'configImportNotObject'
    case 'wrong-format': return 'configImportWrongFormat'
    case 'unsupported-version': return 'configImportUnsupportedVersion'
    case 'malformed-provider': return 'configImportMalformed'
  }
}
