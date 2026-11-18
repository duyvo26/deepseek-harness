/** Shadow-repository checkpoints: recording before a mutation and restoring a turn. */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as WorkspaceChanges from '../src/index.ts'
import { endTurn, mutate, scratchDir, settle, startTurn } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const signal = new AbortController().signal

/** Boot the plugin with its checkpoints under a temporary harness home. */
async function boot(): Promise<{ ctx: Context; checkpointHome: string }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const checkpointHome = await scratchDir('dsh-checkpoints-', cleanups)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkspaceChanges, { checkpointHome } as WorkspaceChanges.Config)
  return { ctx, checkpointHome }
}

/** A working directory with one file; no git repository of the user's own. */
async function directory(): Promise<string> {
  const cwd = await scratchDir('dsh-checkpoint-work-', cleanups)
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  await writeFile(join(cwd, 'b.txt'), 'b\n')
  return cwd
}

describe('checkpoint recording', () => {
  it('records before a mutating call and announces it once per turn', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('one'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'a.txt', content: 'x\n' }, 'a.txt',
      () => writeFile(join(cwd, 'a.txt'), 'x\n'))
    await mutate(ctx, session, 1, 'write', { file_path: 'b.txt', content: 'y\n' }, 'b.txt',
      () => writeFile(join(cwd, 'b.txt'), 'y\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    // One checkpoint per turn is what restore addresses; a second call would
    // otherwise move it past the first call's edits.
    expect(session.snapshotEvents().filter(event => event.type === 'workspace/checkpoint').map(event => event.data))
      .toEqual([{ turn: 1 }])
  })

  it('records nothing for a reading call', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('read'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'read', { file_path: 'a.txt' }, 'a.txt', () => Promise.resolve())
    endTurn(session, 1)
    await settle(ctx, session)

    expect(session.snapshotEvents().filter(event => event.type === 'workspace/checkpoint')).toEqual([])
  })

  it('keeps the user’s own repository untouched', async () => {
    const cwd = await directory()
    await writeFile(join(cwd, '.git'), 'not a repository\n')
    const { ctx, checkpointHome } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('outer'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'a.txt', content: 'x\n' }, 'a.txt',
      () => writeFile(join(cwd, 'a.txt'), 'x\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    // The checkpoint went to its own store, and the file that looks like a
    // repository marker is untouched.
    expect(await readFile(join(cwd, '.git'), 'utf8')).toBe('not a repository\n')
    const repositories = await readdir(join(checkpointHome, 'checkpoints'))
    expect(repositories).toHaveLength(1)
  })
})

describe('restoreTurn', () => {
  it('puts the working directory back to the turn-start content', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('restore'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'a.txt', content: 'changed\n' }, 'a.txt',
      () => writeFile(join(cwd, 'a.txt'), 'changed\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    expect(await ctx.workspaceChanges.restoreTurn(session.id, 1, signal)).toContain('a.txt')
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  })

  it('removes a file the turn created', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('created'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'new.txt', content: 'n\n' }, 'new.txt',
      () => writeFile(join(cwd, 'new.txt'), 'n\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    expect(await ctx.workspaceChanges.restoreTurn(session.id, 1, signal)).toContain('new.txt')
    await expect(readFile(join(cwd, 'new.txt'), 'utf8')).rejects.toThrow()
  })

  it('brings back a file the turn deleted', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('deleted'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'bash', { command: 'rm a.txt' }, 'a.txt', () => rm(join(cwd, 'a.txt')))
    endTurn(session, 1)
    await settle(ctx, session)

    await ctx.workspaceChanges.restoreTurn(session.id, 1, signal)
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  })

  it('reports nothing for a turn this Host never checkpointed', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const session = ctx.sessions.create(brandString<SessionId>('none'), { meta: { cwd } })
    expect(await ctx.workspaceChanges.restoreTurn(session.id, 4, signal)).toBeUndefined()
  })

  it('keeps checkpoints of one Session apart from another', async () => {
    const cwd = await directory()
    const { ctx } = await boot()
    const first = ctx.sessions.create(brandString<SessionId>('first'), { meta: { cwd } })
    startTurn(first, 1)
    await settle(ctx, first)
    await mutate(ctx, first, 1, 'write', { file_path: 'a.txt', content: 'first\n' }, 'a.txt',
      () => writeFile(join(cwd, 'a.txt'), 'first\n'))
    endTurn(first, 1)
    await settle(ctx, first)

    const second = ctx.sessions.create(brandString<SessionId>('second'), { meta: { cwd } })
    startTurn(second, 1)
    await settle(ctx, second)
    await mutate(ctx, second, 1, 'write', { file_path: 'a.txt', content: 'second\n' }, 'a.txt',
      () => writeFile(join(cwd, 'a.txt'), 'second\n'))
    endTurn(second, 1)
    await settle(ctx, second)

    // Undoing the first Session returns the content before its own edit only.
    await ctx.workspaceChanges.restoreTurn(first.id, 1, signal)
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  })
})
