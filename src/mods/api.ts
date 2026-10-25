// What a mod imports as "yellowcode/mod". Additions only: a mod written against an older version keeps working.

import type { KeyEvent } from "@opentui/core"
import type { JSX } from "solid-js"

export type ModStorage = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  // The JSON file the values live in, outside the mod's folder.
  readonly path: string
}

export type ModLog = {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export type Dispose = () => void

export type SettingDefinition =
  | { type: "choice"; label: string; options: readonly string[]; default: string; note?: string }
  | { type: "boolean"; label: string; default: boolean; note?: string }
  | { type: "number"; label: string; min: number; max: number; step: number; default: number; unit?: string }
  | { type: "text"; label: string; default: string; note?: string }

export type SettingDefinitions = Record<string, SettingDefinition>

export type SettingValue<D extends SettingDefinition = SettingDefinition> = D extends { type: "boolean" }
  ? boolean
  : D extends { type: "number" }
    ? number
    : string

export type ModSettings<S extends SettingDefinitions> = {
  get<K extends keyof S & string>(id: K): SettingValue<S[K]>
  set<K extends keyof S & string>(id: K, value: SettingValue<S[K]>): void
  // Called right after the value changes, from /mods or from `set`.
  onChange<K extends keyof S & string>(id: K, listener: (value: SettingValue<S[K]>) => void): Dispose
}

export type ModCommand = {
  // Without the slash: "terminal" is /terminal.
  name: string
  description: string
  argumentHint?: string
  run(args: string): void | Promise<void>
}

export type ModKey = {
  // Such as "ctrl+`" or "ctrl+shift+k".
  key: string
  run(): void
  // "pane" keys work only while the mod's pane has the focus; "always" ones anywhere but in a dialog.
  when?: "always" | "pane"
}

export type PanePosition = "bottom" | "right"

export type PaneViewProps = {
  // Rows and columns inside the pane, its edge left out.
  width: number
  height: number
  focused: boolean
  // While the pane has the focus, every key but the mods' shortcuts comes here, ctrl+c and Esc included.
  onKey: (handler: (key: KeyEvent) => void) => void
}

export type ModPaneOptions = {
  id: string
  title: string
  position: () => PanePosition
  // Rows for a bottom pane, columns for a right one.
  size: () => number
  // The user dragged the pane's edge to this size.
  onResize?(size: number): void
  view: (props: PaneViewProps) => JSX.Element
}

export type ModPane = {
  show(): void
  hide(): void
  // Shows the pane and gives it the focus.
  focus(): void
  visible(): boolean
  focused(): boolean
}

export type SidebarZone = "top" | "body" | "bottom"

// A section in the sidebar. The app draws its heading with the open/closed arrow; the mod gives what goes under it.
export type ModSectionOptions = {
  id: string
  title: string
  // "top" is above the session title, "body" between the title and usage, "bottom" under usage. "body" by default.
  zone?: SidebarZone
  // The place in its zone, low first. Tasks is 10 and MCP 20; 30 by default.
  order?: number
  // A short text at the right of the heading.
  right?: () => string
  visible?: () => boolean
  view: (props: { width: number }) => JSX.Element
}

// What a mod can listen to, with what each event carries.
export type ModEvents = {
  // One of Claude's tools finished during a turn.
  "tool-done": { name: string; status: "done" | "error" | "stopped" }
  // Claude's turn ended; error is null when it went well.
  "turn-end": { error: string | null }
  // The terminal window got the focus back.
  focus: Record<string, never>
}

export type ModToolResult = string | { text: string; isError?: boolean }

// A tool Claude can call, as mcp__mod-<mod id>__<name>. Calls go through Claude Code's permission prompt.
export type ModTool = {
  name: string
  description: string
  // A JSON schema object for the arguments.
  input: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
  run(input: Record<string, unknown>): ModToolResult | Promise<ModToolResult>
}

export type ModApi<S extends SettingDefinitions = SettingDefinitions> = {
  readonly id: string
  readonly storage: ModStorage
  readonly log: ModLog
  readonly settings: ModSettings<S>
  readonly commands: { add(command: ModCommand): Dispose }
  readonly keys: { add(key: ModKey): Dispose }
  readonly panes: { add(pane: ModPaneOptions): ModPane }
  readonly tools: { add(tool: ModTool): Dispose }
  readonly sidebar: { add(section: ModSectionOptions): Dispose }
  readonly events: { on<E extends keyof ModEvents>(event: E, handler: (data: ModEvents[E]) => void): Dispose }
  // Runs when the mod is turned off, reloaded or fails, newest first.
  onDispose(dispose: () => void): void
}

export type Cleanup = () => void

export type ModDefinition<S extends SettingDefinitions = SettingDefinitions> = {
  settings?: S
  // Keep it light: start timers, sockets and processes on the first event or command, not here.
  setup(mod: ModApi<S>): void | Cleanup | Promise<void | Cleanup>
}

const BRAND = Symbol.for("yellowcode.mod")

export type DefinedMod = ModDefinition & { readonly [BRAND]: true }

export function defineMod<const S extends SettingDefinitions = SettingDefinitions>(
  definition: ModDefinition<S>,
): DefinedMod {
  return { settings: definition.settings, setup: (mod) => definition.setup(mod), [BRAND]: true }
}

export function isDefinedMod(value: unknown): value is DefinedMod {
  return (
    typeof value === "object" &&
    value !== null &&
    BRAND in value &&
    "setup" in value &&
    typeof value.setup === "function"
  )
}
