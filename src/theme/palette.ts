import type { CliRenderer, TerminalColors, ThemeMode } from "@opentui/core"
import { log } from "../log/log.ts"

export type Tints = {
  band: string
  tile: string
  dimTile: string
  selection: string
  diffAdd: string
  diffDel: string
  frame: string
  dimFrame: string
  faint: string
  dimAccent: string | null
  warningBand: string | null
  warningLine: string | null
  errorBand: string
  errorLine: string
}

const HEX = /^#[0-9a-f]{6}$/i

function hex(value: string | null | undefined): string | null {
  return value && HEX.test(value) ? value : null
}

function channel(color: string, i: number): number {
  return Number.parseInt(color.slice(1 + i * 2, 3 + i * 2), 16)
}

export function mix(from: string, to: string, amount: number): string {
  const mixed = [0, 1, 2].map((i) => {
    const start = channel(from, i)
    return Math.round(start + (channel(to, i) - start) * amount)
  })
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

export function tintsFrom(colors: TerminalColors): Tints | null {
  const background = hex(colors.defaultBackground)
  const foreground = hex(colors.defaultForeground)
  const red = hex(colors.palette[1])
  const green = hex(colors.palette[2])
  if (!background || !foreground || !red || !green) return null
  const yellow = hex(colors.palette[3])
  const blue = hex(colors.palette[4])
  return {
    band: mix(background, foreground, 0.06),
    tile: mix(background, foreground, 0.1),
    dimTile: mix(background, foreground, 0.05),
    selection: mix(background, foreground, 0.1),
    diffAdd: mix(background, green, 0.18),
    diffDel: mix(background, red, 0.18),
    frame: mix(background, foreground, 0.3),
    dimFrame: mix(background, foreground, 0.165),
    faint: mix(background, foreground, 0.45),
    dimAccent: blue ? mix(blue, foreground, 0.5) : null,
    warningBand: yellow ? mix(background, yellow, 0.09) : null,
    warningLine: yellow ? mix(background, yellow, 0.16) : null,
    errorBand: mix(background, red, 0.09),
    errorLine: mix(background, red, 0.16),
  }
}

export function isDark(background: string | null): boolean {
  const value = hex(background)
  if (!value) return true
  const [r, g, b] = [0, 1, 2].map((i) => channel(value, i))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 128
}

// palette holds the 16 ANSI colors as hex where the terminal reported them; images need real RGB values.
// background and foreground are the terminal's default colors, null when it did not report them.
export type TerminalLook = {
  tints: Tints | null
  dark: boolean
  palette: (string | null)[]
  background: string | null
  foreground: string | null
}

// Stand-ins for a terminal that reports only whether it is dark or light. They are used for blending under a dialog's
// dim; a cell in the default colors is still drawn in the terminal's own.
const SCHEME_COLORS: Record<ThemeMode, { background: string; foreground: string }> = {
  dark: { background: "#161616", foreground: "#d4d4d4" },
  light: { background: "#f6f6f6", foreground: "#1c1c1c" },
}

// COLORFGBG is "fg;bg" or "fg;default;bg" in ANSI indexes; 0 to 6 and 8 are dark backgrounds.
export function schemeFromColorFgBg(value: string | undefined): ThemeMode | null {
  const background = value?.split(";").at(-1)
  if (background === undefined || !/^\d+$/.test(background)) return null
  const index = Number(background)
  return index <= 6 || index === 8 ? "dark" : "light"
}

export async function readTerminal(renderer: CliRenderer): Promise<TerminalLook> {
  const look = await readPalette(renderer)
  if (look.background && look.foreground) return look
  const mode = (await renderer.waitForThemeMode(300).catch(() => null)) ?? schemeFromColorFgBg(process.env.COLORFGBG)
  if (!mode) return look
  log.info("terminal colors guessed from the color scheme", mode)
  return { ...look, dark: mode === "dark", ...SCHEME_COLORS[mode] }
}

async function readPalette(renderer: CliRenderer): Promise<TerminalLook> {
  try {
    const colors = await renderer.getPalette({ timeout: 300 })
    const tints = tintsFrom(colors)
    if (tints) log.info("palette tints", tints)
    else log.info("palette without hex colors, using the 16-color fallback", colors)
    return {
      tints,
      dark: isDark(colors.defaultBackground),
      palette: colors.palette.slice(0, 16).map(hex),
      background: hex(colors.defaultBackground),
      foreground: hex(colors.defaultForeground),
    }
  } catch (error) {
    log.warn("palette query failed, using the 16-color fallback", error)
    return { tints: null, dark: true, palette: [], background: null, foreground: null }
  }
}
