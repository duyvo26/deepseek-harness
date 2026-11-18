// @vitest-environment jsdom
/** Project highlight colours: storage round-trip, palette guards, and write semantics. */
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_COLORS_STORAGE_KEY, WORKSPACE_COLOR_KEYS, createWorkspaceColorStore, decodeWorkspaceColors,
  isWorkspaceColor,
} from '../src/client/workspace-colors.ts'
import type { WorkspaceColorState } from '../src/client/workspace-colors.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

const WORKSPACE = 'w-1' as WorkspaceId
const OTHER = 'w-2' as WorkspaceId

/** An in-memory storage adapter standing in for localStorage. */
function memoryStorage(initial?: unknown): {
  read: () => unknown
  write: (state: WorkspaceColorState) => void
  written: () => unknown
} {
  let stored: unknown = initial
  return {
    read: () => stored,
    write: (state) => { stored = JSON.parse(JSON.stringify(state)) as unknown },
    written: () => stored,
  }
}

describe('palette', () => {
  it('offers six distinguishable colours', () => {
    expect(WORKSPACE_COLOR_KEYS).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple'])
  })

  it.each(WORKSPACE_COLOR_KEYS)('accepts the palette entry %s', (color) => {
    expect(isWorkspaceColor(color)).toBe(true)
  })

  it.each([['crimson'], [''] , [7], [null], [undefined], [{}]])('refuses %s', (value) => {
    expect(isWorkspaceColor(value)).toBe(false)
  })
})

describe('decodeWorkspaceColors', () => {
  it('keeps known assignments', () => {
    expect(decodeWorkspaceColors({ [WORKSPACE]: 'red', [OTHER]: 'blue' }))
      .toEqual({ [WORKSPACE]: 'red', [OTHER]: 'blue' })
  })

  it('drops an assignment naming a colour this build does not render', () => {
    expect(decodeWorkspaceColors({ [WORKSPACE]: 'chartreuse', [OTHER]: 'green' }))
      .toEqual({ [OTHER]: 'green' })
  })

  it.each([[null], [[]], ['red'], [7]])('reads %s as no assignments', (raw) => {
    expect(decodeWorkspaceColors(raw)).toEqual({})
  })
})

describe('createWorkspaceColorStore', () => {
  it('starts from what storage held', () => {
    const handle = createWorkspaceColorStore(memoryStorage({ [WORKSPACE]: 'purple' }))
    expect(handle.store.getSnapshot()).toEqual({ [WORKSPACE]: 'purple' })
  })

  it('ignores a stored colour the palette no longer offers', () => {
    const handle = createWorkspaceColorStore(memoryStorage({ [WORKSPACE]: 'magenta' }))
    expect(handle.store.getSnapshot()).toEqual({})
  })

  it('assigns a colour and persists it', () => {
    const storage = memoryStorage()
    const handle = createWorkspaceColorStore(storage)
    handle.setColor(WORKSPACE, 'green')
    expect(handle.store.getSnapshot()).toEqual({ [WORKSPACE]: 'green' })
    expect(storage.written()).toEqual({ [WORKSPACE]: 'green' })
  })

  it('clears one Workspace without touching the others', () => {
    const storage = memoryStorage({ [WORKSPACE]: 'red', [OTHER]: 'blue' })
    const handle = createWorkspaceColorStore(storage)
    handle.setColor(WORKSPACE, undefined)
    expect(handle.store.getSnapshot()).toEqual({ [OTHER]: 'blue' })
    expect(storage.written()).toEqual({ [OTHER]: 'blue' })
  })

  it('treats clearing an unassigned Workspace as a no-op', () => {
    const handle = createWorkspaceColorStore(memoryStorage({ [OTHER]: 'red' }))
    handle.setColor(WORKSPACE, undefined)
    expect(handle.store.getSnapshot()).toEqual({ [OTHER]: 'red' })
  })

  it('replaces an existing colour rather than stacking assignments', () => {
    const handle = createWorkspaceColorStore(memoryStorage({ [WORKSPACE]: 'red' }))
    handle.setColor(WORKSPACE, 'blue')
    expect(handle.store.getSnapshot()).toEqual({ [WORKSPACE]: 'blue' })
  })

  it('publishes every change to subscribers', () => {
    const handle = createWorkspaceColorStore(memoryStorage())
    const seen: (WorkspaceColorState)[] = []
    handle.store.subscribe(() => { seen.push(handle.store.getSnapshot()) })
    handle.setColor(WORKSPACE, 'orange')
    handle.setColor(WORKSPACE, 'red')
    handle.setColor(WORKSPACE, undefined)
    expect(seen).toEqual([{ [WORKSPACE]: 'orange' }, { [WORKSPACE]: 'red' }, {}])
  })
})

describe('storage failure containment', () => {
  it('keeps the in-memory choice when the write throws', () => {
    const failing = {
      read: () => ({}),
      write: () => { throw new QuotaExceededError() },
    }
    const handle = createWorkspaceColorStore(failing)
    // A denied write must not reject the click that caused it.
    expect(() => { handle.setColor(WORKSPACE, 'blue') }).not.toThrow()
    expect(handle.store.getSnapshot()).toEqual({ [WORKSPACE]: 'blue' })
  })
})

/**
 * The browser reports a full or denied localStorage write this way; jsdom has
 * no constructor for it, so a plain Error carrying the name is enough.
 */
class QuotaExceededError extends Error {
  constructor() {
    super('quota exceeded')
    this.name = 'QuotaExceededError'
  }
}

describe('default storage', () => {
  it('names a versioned key so a future shape change starts clean', () => {
    expect(WORKSPACE_COLORS_STORAGE_KEY).toBe('dsh.workspace.colors.v1')
  })

  it('writes and reads through localStorage when it exists', () => {
    const handle = createWorkspaceColorStore()
    handle.setColor(WORKSPACE, 'yellow')
    expect(localStorage.getItem(WORKSPACE_COLORS_STORAGE_KEY)).toBe(JSON.stringify({ [WORKSPACE]: 'yellow' }))
    const reopened = createWorkspaceColorStore()
    expect(reopened.store.getSnapshot()).toEqual({ [WORKSPACE]: 'yellow' })
    localStorage.clear()
  })

  it('reads a malformed stored value as no assignments', () => {
    localStorage.setItem(WORKSPACE_COLORS_STORAGE_KEY, '{not json')
    expect(createWorkspaceColorStore().store.getSnapshot()).toEqual({})
    localStorage.clear()
  })
})
