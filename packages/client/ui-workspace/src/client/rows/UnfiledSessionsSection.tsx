/**
 * Stray-Session management inside Settings.
 *
 * A Session that belongs to no Workspace is not listed in the sidebar, so this
 * section is where one is found again: it lists them and files each under the
 * shared project-less Workspace.
 *
 * @module UnfiledSessionsSection
 */
import { IconFolderOpenRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ArchivedSessionsSection.module.css'

/** One Session that belongs to no Workspace. */
export interface UnfiledSessionRow {
  readonly sessionId: SessionId
  /** Title the row shows. */
  readonly displayTitle: string
}

/** Injected face of the unfiled-Session section. */
export interface UnfiledSessionsSectionInjected {
  hooks: {
    /** Stray rows, rebuilt whenever the Session list changes. */
    unfiledSessions: {
      getSnapshot: () => readonly UnfiledSessionRow[]
      subscribe: (listener: () => void) => () => void
    }
  }
  /** File one Session under the shared project-less Workspace. */
  adopt: (sessionId: SessionId) => Promise<void>
}

/** Props assembled by the settings renderer. */
export type UnfiledSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'workspace'>
  & InjectFace<UnfiledSessionsSectionInjected>

/**
 * Render the unfiled-Session list.
 *
 * Split from the section so the list is testable with plain props.
 * @param props - stray rows, the adopt callback, and localized copy.
 * @returns the rows, or an empty-state line.
 */
export function UnfiledSessionList({ rows, adopt, t }: {
  readonly rows: readonly UnfiledSessionRow[]
  readonly adopt: (sessionId: SessionId) => Promise<void>
  t: UnfiledSessionsSectionProps['t']
}) {
  if (rows.length === 0) {
    return <p className={css.empty}>{t('unfiled.empty')}</p>
  }
  return <ul className={css.list}>
    {rows.map(row => <li key={row.sessionId} className={css.row}>
      <span className={css.icon} aria-hidden><IconFolderOpenRegular /></span>
      <span className={css.text}>
        <span className={css.title}>{row.displayTitle}</span>
        <span className={css.meta}>{row.sessionId}</span>
      </span>
      <span className={css.actions}>
        <button type="button" className={css.action} onClick={() => { void adopt(row.sessionId) }}>
          {t('unfiled.adopt')}
        </button>
      </span>
    </li>)}
  </ul>
}

/**
 * Render the unfiled-Session section inside Settings.
 * @param props - stray rows, the adopt callback, and localized copy.
 * @returns the section.
 */
export function UnfiledSessionsSection({ useUnfiledSessions, adopt, t }: UnfiledSessionsSectionProps) {
  const rows = useUnfiledSessions(unfiled => unfiled)
  return <UnfiledSessionList rows={rows} adopt={adopt} t={t} />
}
