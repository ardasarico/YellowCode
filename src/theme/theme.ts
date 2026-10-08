import { RGBA, SyntaxStyle } from "@opentui/core"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { claudeColor } from "./brand.ts"
import type { TerminalLook, Tints } from "./palette.ts"
import { dusk } from "./themes/dusk.ts"
import { ember } from "./themes/ember.ts"
import { petal } from "./themes/petal.ts"

type SyntaxTokens<T> = { keyword: T; string: T; number: T; function: T; type: T; comment: T }

export type Theme = {
  background: RGBA | null
  text: RGBA
  muted: RGBA
  frame: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
  band: RGBA | null
  tile: RGBA | null
  diffAdd: RGBA | null
  diffDel: RGBA | null
  diffAddText: RGBA
  diffDelText: RGBA
  claude: RGBA
  agents: RGBA[]
  syntax: SyntaxTokens<RGBA>
}

export type ThemeColors = {
  [K in Exclude<keyof Theme, "claude" | "agents" | "syntax">]: string
} & { agents: string[]; syntax: SyntaxTokens<string> }

export type ThemeDefinition = { id: string; name: string; dark: ThemeColors; light: ThemeColors }

export type Terminal = TerminalLook & { rgb: boolean }

const ansi = (index: number) => RGBA.fromIndex(index)
const hex = (value: string) => RGBA.fromHex(value)

export function terminalTheme(terminal: Terminal): Theme {
  const { tints } = terminal
  const tint = (key: keyof Tints) => (tints ? RGBA.fromHex(tints[key]) : null)
  return {
    background: null,
    text: RGBA.defaultForeground(),
    muted: ansi(8),
    frame: tint("frame") ?? ansi(8),
    accent: ansi(4),
    success: ansi(2),
    warning: ansi(3),
    error: ansi(1),
    band: tint("band"),
    tile: tint("tile"),
    diffAdd: tint("diffAdd"),
    diffDel: tint("diffDel"),
    diffAddText: ansi(2),
    diffDelText: ansi(1),
    claude: claudeColor(terminal.rgb),
    agents: [6, 5, 2, 3, 4].map((index) => ansi(index)),
    syntax: { keyword: ansi(4), string: ansi(2), number: ansi(3), function: ansi(4), type: ansi(3), comment: ansi(8) },
  }
}

function paintedTheme(c: ThemeColors): Theme {
  return {
    background: hex(c.background),
    text: hex(c.text),
    muted: hex(c.muted),
    frame: hex(c.frame),
    accent: hex(c.accent),
    success: hex(c.success),
    warning: hex(c.warning),
    error: hex(c.error),
    band: hex(c.band),
    tile: hex(c.tile),
    diffAdd: hex(c.diffAdd),
    diffDel: hex(c.diffDel),
    diffAddText: hex(c.diffAddText),
    diffDelText: hex(c.diffDelText),
    claude: claudeColor(true),
    agents: c.agents.map((value) => hex(value)),
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
  }
}

const painted: ThemeDefinition[] = [dusk, petal, ember]
export const themes = [{ id: "terminal", name: "Terminal" }, ...painted.map(({ id, name }) => ({ id, name }))]

let terminal: Terminal = { tints: null, dark: true, rgb: false }
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

export function nextTheme(): void {
  const index = themes.findIndex((candidate) => candidate.id === themeId())
  setTheme(themes[(index + 1) % themes.length]?.id ?? "terminal")
}

export function setTerminal(next: Terminal): void {
  terminal = next
  setTheme(themeId())
}
