/**
 * Archived-Session management inside Settings.
 *
 * An archived Session leaves the sidebar, so this section is where one is found
 * again: it lists every archived Session with the actions that take it back into
 * the list or delete it for good.
 *
 * @module ArchivedSessionsSection
 */
import { IconArchiveOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ArchivedSessionsSection.module.css'

/** One archived Session as this section lists it. */
export interface ArchivedSessionRow {
  readonly sessionId: SessionId
  /** Title the row shows. */
  readonly displayTitle: string
  /** ISO-8601 last-mutation instant, for the row's secondary line. */
  readonly updatedAt: string
}

/** Injected face of the archived-Session section. */
export interface ArchivedSessionsSectionInjected {
  hooks: {
    /** Archived rows, rebuilt whenever the registry-global archive set changes. */
    archivedSessions: { getSnapshot: () => readonly ArchivedSessionRow[]; subscribe: (listener: () => void) => () => void }
  }
  /** Return one Session to the sidebar. */
  unarchive: (sessionId: SessionId) => Promise<void>
  /** Delete one Session and its stored log. */
  deleteSession: (sessionId: SessionId) => Promise<void>
}

/** Props assembled by the settings renderer. */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'workspace'>
  & InjectFace<ArchivedSessionsSectionInjected>

/**
 * Render one archived-Session row list.
 *
 * Split from the section so the list is testable with plain props; the section
 * only adds the framework seats.
 * @param props - archived rows, the restore and delete callbacks, and localized copy.
 * @returns the rows, or an empty-state line.
 */
export function ArchivedSessionList({ rows, unarchive, deleteSession, t }: {
  readonly rows: readonly ArchivedSessionRow[]
  readonly unarchive: (sessionId: SessionId) => Promise<void>
  readonly deleteSession: (sessionId: SessionId) => Promise<void>
  t: ArchivedSessionsSectionProps['t']
}) {
  if (rows.length === 0) {
    return <p className={css.empty}>{t('archive.empty')}</p>
  }
  return <ul className={css.list}>
    {rows.map(row => <li key={row.sessionId} className={css.row}>
      <span className={css.icon} aria-hidden><IconArchiveOutlineRegular /></span>
      <span className={css.text}>
        <span className={css.title}>{row.displayTitle}</span>
        <span className={css.meta}>{row.sessionId}</span>
      </span>
      <span className={css.actions}>
        <button type="button" className={css.action} onClick={() => { void unarchive(row.sessionId) }}>
          {t('archive.unarchive')}
        </button>
        <button type="button" className={`${css.action} ${css.danger}`}
          onClick={() => { void deleteSession(row.sessionId) }}>
          <IconTrashOutlineRegular />
          <span>{t('archive.delete')}</span>
        </button>
      </span>
    </li>)}
  </ul>
}

/**
 * Render the archived-Session section inside Settings.
 * @param props - archived rows, the restore and delete callbacks, and localized copy.
 * @returns the section.
 */
export function ArchivedSessionsSection({
  useArchivedSessions, unarchive, deleteSession, t,
}: ArchivedSessionsSectionProps) {
  const rows = useArchivedSessions(archived => archived)
  return <ArchivedSessionList rows={rows} unarchive={unarchive} deleteSession={deleteSession} t={t} />
}
