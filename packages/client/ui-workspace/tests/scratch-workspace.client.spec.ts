/** The shared project-less Workspace: path resolution, registration, and protection. */
import { describe, expect, it, vi } from 'vitest'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  SCRATCH_WORKSPACE_DIRECTORY, ensureScratchWorkspace, isScratchWorkspace, scratchWorkspacePath,
} from '../src/client/scratch-workspace.ts'

/** Localized name a caller supplies; the module owns no display copy. */
const GLOBAL_TITLE = 'Global'

const HOME = '/Users/tester'

function view(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: 'w-global' as WorkspaceId,
    path: `${HOME}/.dsh/scratch`,
    title: SCRATCH_WORKSPACE_DIRECTORY,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A Workspace Controller double recording the calls the helper makes. */
function workspacesDouble(created: WorkspaceView): {
  workspaces: IWorkspaces
  create: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(async () => created)
  const rename = vi.fn(async (_id: WorkspaceId, title: string) => ({ ...created, title }))
  return {
    workspaces: { create, rename } as unknown as IWorkspaces,
    create,
    rename,
  }
}

describe('scratchWorkspacePath', () => {
  it('places the shared directory under the harness home', () => {
    expect(scratchWorkspacePath(HOME)).toBe(`${HOME}/.dsh/scratch`)
  })

  it('tolerates a trailing separator on the host home', () => {
    expect(scratchWorkspacePath(`${HOME}/`)).toBe(`${HOME}/.dsh/scratch`)
    expect(scratchWorkspacePath(`${HOME}///`)).toBe(`${HOME}/.dsh/scratch`)
  })

  it.each([[undefined], ['']])('resolves nothing before host facts arrive: %s', (home) => {
    expect(scratchWorkspacePath(home)).toBeUndefined()
  })
})

describe('ensureScratchWorkspace', () => {
  it('registers the directory on first use', async () => {
    const double = workspacesDouble(view({ title: 'scratch' }))
    const result = await ensureScratchWorkspace(double.workspaces, HOME, GLOBAL_TITLE)
    expect(double.create).toHaveBeenCalledWith({ path: `${HOME}/.dsh/scratch` })
    expect(result?.title).toBe(GLOBAL_TITLE)
  })

  it('names the row Global while it still carries the derived directory name', async () => {
    const double = workspacesDouble(view({ title: SCRATCH_WORKSPACE_DIRECTORY }))
    await ensureScratchWorkspace(double.workspaces, HOME, GLOBAL_TITLE)
    expect(double.rename).toHaveBeenCalledWith('w-global', GLOBAL_TITLE)
  })

  it('leaves a user-chosen title alone on later chats', async () => {
    const double = workspacesDouble(view({ title: 'My notes' }))
    const result = await ensureScratchWorkspace(double.workspaces, HOME, GLOBAL_TITLE)
    expect(double.rename).not.toHaveBeenCalled()
    expect(result?.title).toBe('My notes')
  })

  it('does not register anything before host facts arrive', async () => {
    const double = workspacesDouble(view())
    expect(await ensureScratchWorkspace(double.workspaces, undefined, GLOBAL_TITLE)).toBeUndefined()
    expect(double.create).not.toHaveBeenCalled()
  })
})

describe('isScratchWorkspace', () => {
  it('recognises the shared Workspace by its directory', () => {
    expect(isScratchWorkspace(view(), HOME)).toBe(true)
  })

  it('recognises it even after the user renames the row', () => {
    expect(isScratchWorkspace(view({ title: 'Anything' }), HOME)).toBe(true)
  })

  it('does not match an ordinary project', () => {
    expect(isScratchWorkspace(view({ path: '/projects/app' }), HOME)).toBe(false)
  })

  it('does not match a directory that merely ends like the scratch path', () => {
    expect(isScratchWorkspace(view({ path: '/elsewhere/.dsh/scratch' }), HOME)).toBe(false)
  })

  it('matches nothing while the host home is unknown', () => {
    expect(isScratchWorkspace(view(), undefined)).toBe(false)
  })
})
