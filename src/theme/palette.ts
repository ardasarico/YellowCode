import type { CliRenderer, TerminalColors } from "@opentui/core"
import { log } from "../log/log.ts"

export type Tints = { band: string; tile: string; selection: string; diffAdd: string; diffDel: string; frame: string }

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
  return {
    band: mix(background, foreground, 0.06),
    tile: mix(background, foreground, 0.1),
    selection: mix(background, foreground, 0.1),
    diffAdd: mix(background, green, 0.18),
    diffDel: mix(background, red, 0.18),
    frame: mix(background, foreground, 0.3),
  }
}

export function isDark(background: string | null): boolean {
  const value = hex(background)
  if (!value) return true
  const [r, g, b] = [0, 1, 2].map((i) => channel(value, i))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 128
}

// palette holds the 16 ANSI colors as hex where the terminal reported them; images need real RGB values.
export type TerminalLook = { tints: Tints | null; dark: boolean; palette: (string | null)[] }

export async function readTerminal(renderer: CliRenderer): Promise<TerminalLook> {
  try {
    const colors = await renderer.getPalette({ timeout: 300 })
    const tints = tintsFrom(colors)
    if (tints) log.info("palette tints", tints)
    else log.info("palette without hex colors, using the 16-color fallback", colors)
    return { tints, dark: isDark(colors.defaultBackground), palette: colors.palette.slice(0, 16).map(hex) }
  } catch (error) {
    log.warn("palette query failed, using the 16-color fallback", error)
    return { tints: null, dark: true, palette: [] }
  }
}
