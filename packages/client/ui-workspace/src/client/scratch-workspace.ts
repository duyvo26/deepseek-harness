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

/**
 * Whether one Workspace row is the shared project-less one.
 *
 * The Host answers on the row: it alone resolves `$DSH_HOME`, so a browser
 * cannot recognise the directory by path — an earlier revision tried, and a
 * deployment whose harness home was not `~/.dsh` broke it.
 * @param workspace - row to test.
 * @returns whether the row backs project-less chats.
 */
export function isScratchWorkspace(
  workspace: { readonly isGlobal?: boolean } | undefined,
): boolean {
  // A menu target assembled by an older caller may omit the field; absence
  // means "not identified as global", never "global".
  return workspace?.isGlobal === true
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
