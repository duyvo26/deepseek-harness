/** The shared project-less Workspace: registration, naming, and identity. */
import { describe, expect, it, vi } from 'vitest'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  SCRATCH_WORKSPACE_DIRECTORY, ensureScratchWorkspace, isScratchWorkspace,
} from '../src/client/scratch-workspace.ts'

/** Localized name a caller supplies; the module owns no display copy. */
const GLOBAL_TITLE = 'Global'

function view(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: 'w-global' as WorkspaceId,
    path: '/Users/tester/.dsh/scratch',
    isGlobal: true,
    title: SCRATCH_WORKSPACE_DIRECTORY,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A Workspace Controller double recording the calls the helper makes. */
function workspacesDouble(created: WorkspaceView, ensureFailure?: unknown): {
  workspaces: IWorkspaces
  ensureGlobal: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
} {
  const ensureGlobal = vi.fn(async () => {
    if (ensureFailure !== undefined) throw ensureFailure
    return created
  })
  const rename = vi.fn(async (_id: WorkspaceId, title: string) => ({ ...created, title }))
  return {
    workspaces: { ensureGlobal, rename } as unknown as IWorkspaces,
    ensureGlobal,
    rename,
  }
}

describe('ensureScratchWorkspace', () => {
  it('asks the Host to register and create the shared directory', async () => {
    const double = workspacesDouble(view())
    const result = await ensureScratchWorkspace(double.workspaces, GLOBAL_TITLE)
    // No path crosses the wire: the Host alone knows the harness home, which is
    // why an earlier browser-side path guess could not work.
    expect(double.ensureGlobal).toHaveBeenCalledWith()
    expect(result.title).toBe(GLOBAL_TITLE)
  })

  it('names the row Global while it still carries the derived directory name', async () => {
    const double = workspacesDouble(view({ title: SCRATCH_WORKSPACE_DIRECTORY }))
    await ensureScratchWorkspace(double.workspaces, GLOBAL_TITLE)
    expect(double.rename).toHaveBeenCalledWith('w-global', GLOBAL_TITLE)
  })

  it('leaves a user-chosen title alone on later chats', async () => {
    const double = workspacesDouble(view({ title: 'My notes' }))
    const result = await ensureScratchWorkspace(double.workspaces, GLOBAL_TITLE)
    expect(double.rename).not.toHaveBeenCalled()
    expect(result.title).toBe('My notes')
  })

  it('surfaces a refused registration instead of reporting a Workspace', async () => {
    const double = workspacesDouble(view(), new Error('workspace create failed'))
    await expect(ensureScratchWorkspace(double.workspaces, GLOBAL_TITLE)).rejects.toThrow('workspace create failed')
  })
})

describe('isScratchWorkspace', () => {
  it('reads the identity the Host reports on the row', () => {
    expect(isScratchWorkspace(view())).toBe(true)
  })

  it('refuses a Workspace the Host did not mark', () => {
    expect(isScratchWorkspace(view({ isGlobal: false, path: '/projects/app' }))).toBe(false)
  })

  it('does not infer identity from the path', () => {
    // The Host resolves `$DSH_HOME`, which a browser cannot compute: a row at a
    // scratch-shaped path is not global unless the Host says so.
    expect(isScratchWorkspace(view({ isGlobal: false, path: '/Users/tester/.dsh/scratch' }))).toBe(false)
  })

  it('keeps recognising the row after the user renames it', () => {
    expect(isScratchWorkspace(view({ title: 'Anything' }))).toBe(true)
  })
})
