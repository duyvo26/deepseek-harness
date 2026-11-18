// @vitest-environment jsdom
/** The Settings section that manages archived Sessions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en } from '../src/client/locales.ts'
import {
  ArchivedSessionList, type ArchivedSessionRow,
} from '../src/client/rows/ArchivedSessionsSection.tsx'

afterEach(() => { cleanup() })

/** The section over a test-owned row source, with the two verbs recorded. */
function section(rows: readonly ArchivedSessionRow[]) {
  const unarchive = vi.fn(async () => {})
  const deleteSession = vi.fn(async () => {})
  const view = (current: readonly ArchivedSessionRow[]) => <ArchivedSessionList
    rows={current}
    unarchive={unarchive}
    deleteSession={deleteSession}
    t={makeTranslate(en)}
  />
  const rendered = render(view(rows))
  const source = { set: (next: readonly ArchivedSessionRow[]) => { rendered.rerender(view(next)) } }
  return { source, unarchive, deleteSession }
}

const row = (id: string, title: string): ArchivedSessionRow => ({
  sessionId: brandString<SessionId>(id), displayTitle: title, updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('ArchivedSessionsSection', () => {
  it('states that nothing is archived instead of rendering an empty list', () => {
    section([])
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText(en['archive.empty'])).toBeTruthy()
  })

  it('lists each archived Session and restores it on demand', () => {
    const { unarchive } = section([row('gone', 'Old chat')])
    expect(screen.getByText('Old chat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['archive.unarchive'] }))
    expect(unarchive).toHaveBeenCalledWith('gone')
  })

  it('deletes an archived Session, which is the only way to remove it for good', () => {
    const { deleteSession } = section([row('gone', 'Old chat')])
    const buttons = screen.getAllByRole('button', { name: en['archive.delete'] })
    fireEvent.click(buttons[0]!)
    expect(deleteSession).toHaveBeenCalledWith('gone')
  })

  it('follows the source as Sessions are archived and restored', () => {
    const { source } = section([row('one', 'First')])
    expect(screen.getByText('First')).toBeTruthy()
    source.set([row('one', 'First'), row('two', 'Second')])
    expect(screen.getByText('Second')).toBeTruthy()
    source.set([])
    expect(screen.getByText(en['archive.empty'])).toBeTruthy()
  })
})
