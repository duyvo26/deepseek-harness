/**
 * Colour swatches for the project highlight menu.
 *
 * Each palette entry registers its own `contextMenu.icon` key, because the menu
 * resolves icons by key and one key cannot vary with the action's own colour.
 * The swatches are module-level components so their identity stays stable
 * across renders.
 *
 * @module WorkspaceColorSwatch
 */

import type { ReactNode } from 'react'
import { WORKSPACE_COLOR_KEYS } from './workspace-colors.ts'
import type { WorkspaceColorKey } from './workspace-colors.ts'
import css from './WorkspaceColorSwatch.module.css'

/** The `contextMenu.icon` key naming one palette swatch. */
export function workspaceColorIconKey(color: WorkspaceColorKey): string {
  return `workspace.color.${color}`
}

/** The `contextMenu.icon` key naming the "no colour" swatch. */
export const WORKSPACE_COLOR_NONE_ICON_KEY = 'workspace.color.none'

/**
 * One palette swatch.
 * @param props.color - palette entry to draw.
 * @returns the swatch element.
 */
function Swatch({ color }: { color: WorkspaceColorKey }): ReactNode {
  return <span className={css.swatch} data-workspace-color={color} aria-hidden="true" />
}

/** A swatch that shows the cleared state as an outlined empty circle. */
function NoneSwatch(): ReactNode {
  return <span className={`${css.swatch} ${css.none}`} aria-hidden="true" />
}

/**
 * The `contextMenu.icon` contributors this plugin registers, in palette order.
 * The clearing entry follows the palette so the menu reads colour-down, clear-last.
 */
export const WORKSPACE_COLOR_ICONS: readonly (readonly [string, () => ReactNode])[] = [
  ...WORKSPACE_COLOR_KEYS.map(color => [workspaceColorIconKey(color), () => <Swatch color={color} />] as const),
  [WORKSPACE_COLOR_NONE_ICON_KEY, NoneSwatch] as const,
]
