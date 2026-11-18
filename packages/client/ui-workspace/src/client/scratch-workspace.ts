/**
 * The project-less chat Workspace.
 *
 * A Session records the directory it was created in and every tool that
 * touches the filesystem resolves against it, so "chat without a project" has
 * to name a directory anyway. The Host owns that directory: it is a `scratch`
 * directory under the harness home, which only the Host can resolve.
 *
 * It is a real Workspace on purpose. Reusing the registry means the row, the
 * menu, the colour highlight, and archiving all work with no special case, and
 * no durable format changes for a Session that is merely somewhere unusual.
 *
 * @module scratch-workspace
 */

import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Directory name the Host creates under its harness home. */
export const SCRATCH_WORKSPACE_DIRECTORY = 'scratch'

/** Harness home directory name, matching the Host's own default. */
const DSH_HOME_DIRECTORY = '.dsh'

/**
 * Resolve the shared Workspace path from the Host home the page received.
 *
 * A browser reaches this only to recognise a row it already has; it never uses
 * the result to register one, because the Host resolves the location itself
 * and `$DSH_HOME` can point somewhere this page cannot compute.
 * @param hostHome - Host account home directory, or undefined before the ready frame.
 * @returns the absolute scratch directory, or undefined when the home is unknown.
 */
export function scratchWorkspacePath(hostHome: string | undefined): string | undefined {
  if (hostHome === undefined || hostHome.length === 0) return undefined
  return `${hostHome.replace(/\/+$/, '')}/${DSH_HOME_DIRECTORY}/${SCRATCH_WORKSPACE_DIRECTORY}`
}

/**
 * Whether one Workspace is the shared project-less one.
 *
 * Recognition is by directory, not by title: the title is user-editable after
 * the first chat, while the path is what every global chat's Sessions record.
 * @param workspace - Workspace to test.
 * @param hostHome - Host account home, or undefined before the ready frame.
 * @returns whether this row is the global Workspace.
 */
export function isScratchWorkspace(
  workspace: Pick<WorkspaceView, 'path'>,
  hostHome: string | undefined,
): boolean {
  const path = scratchWorkspacePath(hostHome)
  return path !== undefined && workspace.path === path
}

/**
 * Whether a Workspace row is the shared project-less one, without host facts.
 *
 * Deleting that row would strand every global chat, and the refusal has to
 * work even before the ready frame names the home, so this matches on the
 * directory's own final segments instead.
 * @param workspace - Workspace to test.
 * @returns whether the row names the shared directory.
 */
export function isScratchWorkspacePath(workspace: Pick<WorkspaceView, 'path'>): boolean {
  return workspace.path.endsWith(`/${DSH_HOME_DIRECTORY}/${SCRATCH_WORKSPACE_DIRECTORY}`)
}

/**
 * Resolve, creating and naming on first use, the Workspace every project-less
 * chat runs in.
 *
 * The Host resolves the directory and creates it, because it alone knows
 * `$DSH_HOME`; the page supplies only the localized display name. Registration
 * is idempotent for one path, so later calls reuse the row. The name is applied
 * only while the row still carries the derived directory name: renaming it is
 * the user's decision, and re-applying a title on every chat would undo that.
 * @param workspaces - Workspace Controller.
 * @param title - localized display name applied while the row still carries the
 *   derived directory name.
 * @returns the global Workspace.
 */
export async function ensureScratchWorkspace(
  workspaces: IWorkspaces,
  title: string,
): Promise<WorkspaceView> {
  const created = await workspaces.ensureGlobal()
  if (created.title !== SCRATCH_WORKSPACE_DIRECTORY) return created
  return workspaces.rename(created.workspaceId, title)
}
