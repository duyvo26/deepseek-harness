/**
 * Project highlight colours: a browser-local choice that marks a Workspace as
 * important in the sidebar.
 *
 * The choice is a viewing preference, not a property of the directory, so it
 * lives in localStorage beside the other Workspace viewing state rather than in
 * the durable Workspace record. It therefore follows this browser rather than
 * the Host: a second machine starts with no colours, and clearing site data
 * clears them.
 *
 * @module workspace-colors
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * The fixed highlight palette. Every entry names a theme token that exists in
 * both themes, so a colour needs no per-theme literal and stays readable when
 * the sidebar background changes.
 */
export const WORKSPACE_COLOR_KEYS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

/** One highlight colour a Workspace may carry. */
export type WorkspaceColorKey = typeof WORKSPACE_COLOR_KEYS[number]

/** Colour assignments by Workspace identity. */
export type WorkspaceColorState = Readonly<Record<string, WorkspaceColorKey>>

/** localStorage key; versioned so a future shape change starts clean. */
export const WORKSPACE_COLORS_STORAGE_KEY = 'dsh.workspace.colors.v1'

/**
 * Whether a value is one of the palette keys.
 * @param value - candidate read from storage or a callback.
 * @returns whether the value names a colour this build knows.
 */
export function isWorkspaceColor(value: unknown): value is WorkspaceColorKey {
  return typeof value === 'string' && (WORKSPACE_COLOR_KEYS as readonly string[]).includes(value)
}

/**
 * Decode the persisted map, dropping anything this build cannot render.
 *
 * Storage is a durable boundary: a value written by another build may carry a
 * colour the palette no longer offers, and the sidebar must not paint an
 * unknown token.
 * @param raw - parsed JSON from storage.
 * @returns assignments naming only known colours.
 */
export function decodeWorkspaceColors(raw: unknown): WorkspaceColorState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries = Object.entries(raw).filter((entry): entry is [string, WorkspaceColorKey] =>
    isWorkspaceColor(entry[1]))
  return Object.fromEntries(entries)
}

/** The colour store one plugin instance owns. */
export interface WorkspaceColorStore {
  /** Assignments the sidebar renders from. */
  readonly store: SnapshotStore<WorkspaceColorState>
  /**
   * Assign or clear one Workspace's colour.
   * @param workspaceId - Workspace identity.
   * @param color - colour to assign, or undefined to clear it.
   */
  setColor(workspaceId: WorkspaceId, color: WorkspaceColorKey | undefined): void
}

/** Storage adapter; a browser without localStorage keeps the in-memory store only. */
interface ColorStorage {
  read(): unknown
  write(state: WorkspaceColorState): void
}

/**
 * localStorage-backed storage, or an empty adapter when storage is unavailable
 * (private mode, quota, or a non-browser boot such as the Node e2e tree).
 * @returns the adapter the store writes through.
 */
function browserStorage(): ColorStorage {
  if (typeof localStorage === 'undefined') return { read: () => ({}), write: () => {} }
  return {
    read: () => {
      const raw = localStorage.getItem(WORKSPACE_COLORS_STORAGE_KEY)
      if (raw === null) return {}
      try {
        return decodeWorkspaceColors(JSON.parse(raw))
      } catch {
        // A malformed stored value is not recoverable state; starting empty
        // keeps the sidebar paintable rather than failing the plugin.
        return {}
      }
    },
    write: (state) => {
      localStorage.setItem(WORKSPACE_COLORS_STORAGE_KEY, JSON.stringify(state))
    },
  }
}

/**
 * Create the colour store for one plugin instance.
 *
 * The factory is exported rather than a module-level handle: a module-level
 * store would pin one identity across plugin reloads.
 * @param storage - storage adapter; tests pass an in-memory one. A failing
 *   write only stops persistence and never rejects the click that caused it.
 * @returns the store handle.
 */
export function createWorkspaceColorStore(storage: ColorStorage = browserStorage()): WorkspaceColorStore {
  const store = createSnapshotStore<WorkspaceColorState>(decodeWorkspaceColors(storage.read()), { flush: 'sync' })
  return {
    store,
    setColor: (workspaceId, color) => {
      const current = store.getSnapshot()
      const next: Record<string, WorkspaceColorKey> = color === undefined
        ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== workspaceId))
        : { ...current, [workspaceId]: color }
      // Publish first: the colour is visible even when it cannot be stored,
      // which is the better failure for a viewing preference.
      store.set(next)
      try {
        storage.write(next)
      } catch {
        // Quota or a denied write only stops persistence for later sessions.
      }
    },
  }
}
