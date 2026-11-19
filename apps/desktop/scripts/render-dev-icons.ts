/**
 * Render the DEV-marked application icons from the committed platform artwork.
 *
 * A locally built application uses the same whale as a release, so the Dock and
 * the Windows taskbar cannot tell the two apart. This adds a DEV badge in the
 * band below the whale, inside the tile, and writes `resources/icon-*-dev.png`
 * for the packaging configuration to select instead of the release artwork.
 *
 * Placement is measured from the committed PNGs rather than hardcoded, so
 * re-exporting the artwork moves the badge with it. Rerun
 * `pnpm run render:dev-icons` in `apps/desktop` after changing a source icon.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** One platform's source artwork and the file this script writes beside it. */
export interface DevIconTarget {
  readonly source: string
  readonly output: string
  /** Vertical space between the whale's lowest ink and the badge's top edge, in source pixels. */
  readonly whaleGap: number
}

/** Sources and outputs, resolved from the desktop package's `resources` directory. */
export const DEV_ICON_TARGETS: readonly DevIconTarget[] = [
  {
    source: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
    output: fileURLToPath(new URL('../resources/icon-macos-dev.png', import.meta.url)),
    whaleGap: 10,
  },
  {
    source: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
    output: fileURLToPath(new URL('../resources/icon-windows-dev.png', import.meta.url)),
    whaleGap: 14,
  },
]

/** Badge wordmark. */
const BADGE_TEXT = 'DEV'
/** Badge cap height as a fraction of the tile's width, so both platforms share one scale. */
const BADGE_TEXT_RATIO = 0.094
/** Badge fill, the artwork's own dark gradient end stop. */
const BADGE_FILL = '#1C2434'
/** Shadow color behind the badge, the artwork's deepest ink. */
const SHADOW_FILL = '#0F1115'
/** Wordmark stack; the badge is rasterized once and carries no font dependency at runtime. */
const WORDMARK_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif'
/** Alpha above which a pixel counts as covered tile. */
const TILE_ALPHA = 8
/** Luminance below which a covered pixel counts as whale ink rather than tile. */
const WHALE_LUMINANCE = 120
/** Padding around the badge artwork, in device pixels, large enough for the shadow. */
const BADGE_INSET = 48

/** Axis-aligned extent of a set of pixels. */
interface Bounds {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Read one source icon's pixel buffer.
 * @param path - Absolute PNG path.
 * @returns Raw RGBA pixels and the image dimensions.
 */
async function readPixels(path: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Measure the covered tile and the whale ink inside it.
 * @param pixels - Raw RGBA pixels of a square icon.
 * @returns Tile extent and whale ink extent in source pixels.
 */
function measure(pixels: { data: Buffer; width: number; height: number }): { tile: Bounds; whale: Bounds } {
  const { data, width, height } = pixels
  let tile: Bounds | undefined
  let whale: Bounds | undefined
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      if (data[at + 3]! <= TILE_ALPHA) continue
      tile = grow(tile, x, y)
      const luminance = (data[at]! + data[at + 1]! + data[at + 2]!) / 3
      if (luminance < WHALE_LUMINANCE) whale = grow(whale, x, y)
    }
  }
  if (tile === undefined) throw new Error('dev icons: source artwork is fully transparent')
  if (whale === undefined) throw new Error('dev icons: source artwork carries no dark whale ink')
  return { tile, whale }
}

/**
 * Extend an extent to include one pixel.
 * @param bounds - Extent so far, or undefined for the first pixel.
 * @param x - Pixel column.
 * @param y - Pixel row.
 * @returns The extended extent.
 */
function grow(bounds: Bounds | undefined, x: number, y: number): Bounds {
  if (bounds === undefined) return { left: x, top: y, right: x, bottom: y }
  return {
    left: Math.min(bounds.left, x),
    top: Math.min(bounds.top, y),
    right: Math.max(bounds.right, x),
    bottom: Math.max(bounds.bottom, y),
  }
}

/** Trimmed raster layer. */
interface InkLayer {
  readonly png: Buffer
  readonly width: number
  readonly height: number
}

/** Badge raster layer with the padding carried around the visible fill. */
interface BadgeLayer extends InkLayer {
  readonly inset: number
}

/**
 * Rasterize the wordmark and trim it to its ink, so placement never depends on
 * font baselines or side bearings.
 * @param fontSize - Font size used to rasterize, large enough to scale down cleanly.
 * @returns Trimmed ink layer and its size.
 */
async function wordmarkInk(fontSize: number): Promise<InkLayer> {
  const markup = `<svg width="1800" height="600" xmlns="http://www.w3.org/2000/svg">
    <text x="60" y="420" font-family="${WORDMARK_FONT}" font-size="${fontSize}" font-weight="700"
      letter-spacing="${fontSize * 0.045}" fill="#FFFFFF">${BADGE_TEXT}</text></svg>`
  const trimmed = await sharp(Buffer.from(markup)).trim({ threshold: 10 }).png().toBuffer({ resolveWithObject: true })
  return { png: trimmed.data, width: trimmed.info.width, height: trimmed.info.height }
}

/**
 * Draw the badge: a rounded fill with the wordmark centered over it and a soft shadow behind.
 * @param ink - Trimmed wordmark layer.
 * @param textHeight - Cap height the wordmark is scaled to.
 * @returns Badge layer and the padding it carries around the visible fill.
 */
async function badge(ink: InkLayer, textHeight: number): Promise<BadgeLayer> {
  const scale = textHeight / ink.height
  const textWidth = Math.round(ink.width * scale)
  const text = await sharp(ink.png).resize(textWidth, textHeight, { fit: 'fill' }).png().toBuffer()
  const padX = Math.round(textHeight * 0.66)
  const padY = Math.round(textHeight * 0.40)
  const width = textWidth + padX * 2
  const height = textHeight + padY * 2
  const radius = Math.round(height * 0.30)
  const markup = `<svg width="${width + BADGE_INSET * 2}" height="${height + BADGE_INSET * 2}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="shadow" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="${(height * 0.11).toFixed(2)}"/></filter></defs>
    <rect x="${BADGE_INSET}" y="${BADGE_INSET + Math.round(height * 0.10)}" width="${width}" height="${height}"
      rx="${radius}" fill="${SHADOW_FILL}" opacity="0.22" filter="url(#shadow)"/>
    <rect x="${BADGE_INSET}" y="${BADGE_INSET}" width="${width}" height="${height}" rx="${radius}" fill="${BADGE_FILL}"/>
  </svg>`
  const png = await sharp(Buffer.from(markup))
    .composite([{ input: text, left: BADGE_INSET + padX, top: BADGE_INSET + padY }])
    .png()
    .toBuffer()
  return { png, width: width + BADGE_INSET * 2, height: height + BADGE_INSET * 2, inset: BADGE_INSET }
}

/**
 * Render one DEV icon beside its source artwork.
 * @param target - Source, output, and spacing for one platform.
 * @returns The written output path.
 */
export async function renderDevIcon(target: DevIconTarget): Promise<string> {
  const pixels = await readPixels(target.source)
  const { tile, whale } = measure(pixels)
  const ink = await wordmarkInk(300)
  const layer = await badge(ink, Math.round((tile.right - tile.left + 1) * BADGE_TEXT_RATIO))
  const left = Math.round((tile.left + tile.right) / 2 - layer.width / 2)
  // Keep the fill above the tile's bottom edge even when the whale sits low in the artwork.
  const lowestTop = tile.bottom - (layer.height - layer.inset) - target.whaleGap
  const top = Math.min(Math.round(whale.bottom + target.whaleGap - layer.inset), lowestTop)
  const composed = await sharp(await readFile(target.source))
    .ensureAlpha()
    .composite([{ input: layer.png, left, top }])
    .png()
    .toBuffer()
  await writeFile(target.output, composed)
  return target.output
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const target of DEV_ICON_TARGETS) process.stdout.write(`${await renderDevIcon(target)}\n`)
}
