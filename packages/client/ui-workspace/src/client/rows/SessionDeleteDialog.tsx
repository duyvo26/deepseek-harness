/**
 * Confirmation for deleting a Session.
 *
 * Deleting removes the stored log, so unlike archiving it cannot be undone. The
 * confirmation names the Session and states that consequence before the
 * destructive call runs.
 *
 * @module SessionDeleteDialog
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionDeleteConfirmProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** Props of the delete confirmation. */
export type SessionDeleteDialogProps = SessionDeleteConfirmProps

/**
 * Render the confirmation a delete menu action raised.
 * @param props - the pending request, the settle and delete callbacks, and localized copy.
 * @returns the modal, which renders nothing while no request is pending.
 */
export function SessionDeleteDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteDialogProps) {
  const target = useDeleteRequest(request => request)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    if (deleting) return
    setError(null)
    settleSessionDelete()
  }
  const confirm = (): void => {
    if (deleting || target === null) return
    setDeleting(true)
    setError(null)
    deleteSession(target.sessionId)
      .then(() => { settleSessionDelete() })
      .catch((reason: unknown) => {
        setDeleting(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }
  return <Modal
    open={target !== null}
    onClose={close}
    closeLabel={t('close')}
    title={t('delete.session.title')}
    {...target === null ? {} : { description: t('delete.session.body', { name: target.displayTitle }) }}
    footer={(
      <>
        <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
        <Button variant="outline" className={css.deleteAction} disabled={deleting} onClick={confirm}>
          {t('delete.session.confirm')}
        </Button>
      </>
    )}
  >
    {error !== null && <div className={css.renameError} role="alert">{error}</div>}
  </Modal>
}
