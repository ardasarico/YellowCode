import { RGBA, SyntaxStyle } from "@opentui/core"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { claudeColor } from "./brand.ts"
import { mix, type TerminalLook, type Tints } from "./palette.ts"
import { dusk } from "./themes/dusk.ts"
import { ember } from "./themes/ember.ts"
import { petal } from "./themes/petal.ts"

type SyntaxTokens<T> = { keyword: T; string: T; number: T; function: T; type: T; comment: T }

export type Theme = {
  background: RGBA | null
  text: RGBA
  muted: RGBA
  faint: RGBA
  success: RGBA
  frame: RGBA
  dimFrame: RGBA
  accent: RGBA
  dimAccent: RGBA
  warning: RGBA
  error: RGBA
  warningBand: RGBA | null
  warningLine: RGBA | null
  errorBand: RGBA | null
  errorLine: RGBA | null
  band: RGBA | null
  tile: RGBA | null
  dimTile: RGBA | null
  selection: RGBA | null
  diffAdd: RGBA | null
  diffDel: RGBA | null
  diffAddText: RGBA
  diffDelText: RGBA
  claude: RGBA
  agents: RGBA[]
  rgb: boolean
  syntax: SyntaxTokens<RGBA>
}

export type ThemeColors = {
  [
    K in Exclude<
      keyof Theme,
      | "faint"
      | "dimFrame"
      | "dimTile"
      | "dimAccent"
      | "success"
      | "warningBand"
      | "warningLine"
      | "errorBand"
      | "errorLine"
      | "claude"
      | "agents"
      | "syntax"
      | "rgb"
    >
  ]: string
} & { agents: string[]; syntax: SyntaxTokens<string> }

export type ThemeDefinition = { id: string; name: string; dark: ThemeColors; light: ThemeColors }

export type Terminal = TerminalLook & { rgb: boolean }

const hex = (value: string) => RGBA.fromHex(value)

export function terminalTheme(terminal: Terminal): Theme {
  const { tints, palette } = terminal
  const ansi = (index: number) => RGBA.fromIndex(index, palette[index] ?? undefined)
  const tint = (key: keyof Tints) => {
    const value = tints?.[key]
    return value ? RGBA.fromHex(value) : null
  }
  return {
    background: null,
    text: RGBA.defaultForeground(),
    muted: ansi(8),
    faint: tint("faint") ?? ansi(8),
    success: ansi(2),
    frame: tint("frame") ?? ansi(8),
    dimFrame: tint("dimFrame") ?? ansi(8),
    accent: ansi(4),
    dimAccent: tint("dimAccent") ?? RGBA.defaultForeground(),
    warning: ansi(3),
    error: ansi(1),
    warningBand: tint("warningBand"),
    warningLine: tint("warningLine"),
    errorBand: tint("errorBand"),
    errorLine: tint("errorLine"),
    band: tint("band"),
    tile: tint("tile"),
    dimTile: tint("dimTile"),
    selection: tint("selection"),
    diffAdd: tint("diffAdd"),
    diffDel: tint("diffDel"),
    diffAddText: ansi(2),
    diffDelText: ansi(1),
    claude: claudeColor(terminal.rgb),
    agents: [6, 5, 2, 3, 4].map((index) => ansi(index)),
    rgb: terminal.rgb,
    syntax: { keyword: ansi(4), string: ansi(2), number: ansi(3), function: ansi(4), type: ansi(3), comment: ansi(8) },
  }
}

function paintedTheme(c: ThemeColors): Theme {
  return {
    background: hex(c.background),
    text: hex(c.text),
    muted: hex(c.muted),
    faint: hex(mix(c.muted, c.background, 0.4)),
    success: hex(c.diffAddText),
    frame: hex(c.frame),
    dimFrame: hex(mix(c.frame, c.background, 0.45)),
    accent: hex(c.accent),
    dimAccent: hex(mix(c.accent, c.text, 0.5)),
    warning: hex(c.warning),
    error: hex(c.error),
    warningBand: hex(mix(c.background, c.warning, 0.09)),
    warningLine: hex(mix(c.background, c.warning, 0.16)),
    errorBand: hex(mix(c.background, c.error, 0.09)),
    errorLine: hex(mix(c.background, c.error, 0.16)),
    band: hex(c.band),
    tile: hex(c.tile),
    dimTile: hex(mix(c.tile, c.background, 0.5)),
    selection: hex(c.selection),
    diffAdd: hex(c.diffAdd),
    diffDel: hex(c.diffDel),
    diffAddText: hex(c.diffAddText),
    diffDelText: hex(c.diffDelText),
    claude: claudeColor(true),
    agents: c.agents.map((value) => hex(value)),
    rgb: true,
    syntax: {
      keyword: hex(c.syntax.keyword),
      string: hex(c.syntax.string),
      number: hex(c.syntax.number),
      function: hex(c.syntax.function),
      type: hex(c.syntax.type),
      comment: hex(c.syntax.comment),
    },
  }
}

function syntaxStyles(t: Theme) {
  return {
    default: { fg: t.text },
    keyword: { fg: t.syntax.keyword, bold: true },
    string: { fg: t.syntax.string },
    comment: { fg: t.syntax.comment, italic: true },
    number: { fg: t.syntax.number },
    function: { fg: t.syntax.function },
    type: { fg: t.syntax.type },
    "input-token": { fg: t.accent },
  }
}

const painted: ThemeDefinition[] = [dusk, petal, ember]
export const themes = [{ id: "terminal", name: "Terminal" }, ...painted.map(({ id, name }) => ({ id, name }))]

let terminal: Terminal = { tints: null, dark: true, rgb: false, palette: [] }
const initial = terminalTheme(terminal)
const [theme, setThemeStore] = createStore<Theme>(initial)
const [themeId, setThemeId] = createSignal("terminal")
const [syntaxStyle, setSyntaxStyle] = createSignal(SyntaxStyle.fromStyles(syntaxStyles(initial)))

export { syntaxStyle, theme, themeId }

function build(id: string): Theme {
  const definition = painted.find((candidate) => candidate.id === id)
  if (!definition) return terminalTheme(terminal)
  return paintedTheme(terminal.dark ? definition.dark : definition.light)
}

export function setTheme(id: string): void {
  const next = build(id)
  const previous = syntaxStyle()
  setThemeId(themes.some((candidate) => candidate.id === id) ? id : "terminal")
  setThemeStore(next)
  // Code blocks bake colors in when they highlight, so a new style object is what makes them re-highlight.
  setSyntaxStyle(SyntaxStyle.fromStyles(syntaxStyles(next)))
  setTimeout(() => previous.destroy(), 0)
}

export function setTerminal(next: Terminal): void {
  terminal = next
  setTheme(themeId())
}
