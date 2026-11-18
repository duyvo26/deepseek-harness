/**
 * The project-less chat Workspace.
 *
 * A Session records the directory it was created in and every tool that
 * touches the filesystem resolves against it, so "chat without a project" has
 * to name a directory anyway. This module owns the single shared one: a
 * `scratch` directory under the Host's own harness home, registered as an
 * ordinary Workspace the first time a user asks for a project-less chat.
 *
 * It is a real Workspace on purpose. Reusing the registry means the row, the
 * menu, the colour highlight, and archiving all work with no special case, and
 * no durable format changes for a Session that is merely somewhere unusual.
 *
 * @module scratch-workspace
 */

import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Directory name created under the harness home. */
export const SCRATCH_WORKSPACE_DIRECTORY = 'scratch'

/** Harness home directory name, matching the Host's own default. */
const DSH_HOME_DIRECTORY = '.dsh'

/**
 * Resolve the project-less Workspace path from the Host home the page
 * received.
 *
 * The Host home is the user's account home (the ready frame's `host.home`),
 * and the harness home is `~/.dsh` beneath it, matching the Host's own
 * default resolution. A page that has not received host facts yet cannot name
 * the directory, so the caller must wait rather than guess.
 * @param hostHome - Host account home directory, or undefined before the ready frame.
 * @returns the absolute scratch directory, or undefined when the home is unknown.
 */
export function scratchWorkspacePath(hostHome: string | undefined): string | undefined {
  if (hostHome === undefined || hostHome.length === 0) return undefined
  // POSIX paths join without the separator already present; the separator is
  // literal because the Host resolves a fully qualified path on its own OS.
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
 * Resolve, creating and naming on first use, the Workspace every project-less
 * chat runs in.
 *
 * `Workspaces.create` is idempotent for one path, so the first global chat
 * registers the row and later ones reuse it. The row is titled only while it
 * still carries the auto-derived path name: renaming it is the user's
 * decision, and re-applying the title on every chat would undo it.
 * @param workspaces - Workspace Controller.
 * @param hostHome - Host account home, or undefined before the ready frame.
 * @param title - localized display name applied while the row still carries the
 *   derived directory name.
 * @returns the global Workspace, or undefined when the home is still unknown.
 */
export async function ensureScratchWorkspace(
  workspaces: IWorkspaces,
  hostHome: string | undefined,
  title: string,
): Promise<WorkspaceView | undefined> {
  const path = scratchWorkspacePath(hostHome)
  if (path === undefined) return undefined
  const created = await workspaces.create({ path })
  if (created.title !== SCRATCH_WORKSPACE_DIRECTORY) return created
  return workspaces.rename(created.workspaceId, title)
}
