// What a mod imports as "yellowcode/mod", versioned as `apiVersion`. Within a major version things are only added: new
// fields, methods, union members and props fields. A mod written against an older 1.x keeps working; a mod that
// switches exhaustively over a union should keep a default case.

import type { KeyEvent } from "@opentui/core"
import type { Component, JSX } from "solid-js"
import type { PromptBarProps, StatusLineProps } from "../ui/prompt-bar.tsx"
import type { SystemRowProps } from "../ui/system-row.tsx"
import type { ThinkingRowProps } from "../ui/thinking.tsx"
import type { TurnEndRowProps } from "../ui/turn-end.tsx"
import type { UserMessageRowProps } from "../ui/user-message.tsx"

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

export type ModChooseOptions = {
  title: string
  items: { id: string; label: string; note?: string }[]
  // Shown by default when there are more than a few items.
  search?: boolean
}

export type ModConfirmOptions = { title: string; message: string; action: string }

export type ModInputOptions = { title: string; placeholder?: string; initial?: string }

export type ModDialogViewProps = {
  // Rows and columns for the mod's content, the title and footer left out.
  width: number
  height: number
  // Every key but Esc, which closes the dialog, comes here.
  onKey: (handler: (key: KeyEvent) => void) => void
  close(): void
}

export type ModDialogOptions = {
  title: string
  // Nearly the whole screen instead of the usual dialog width.
  wide?: boolean
  // Footer hints, like "↑↓ scroll".
  hints?: { key: string; action: string }[]
  view: (props: ModDialogViewProps) => JSX.Element
}

// One dialog is open at a time. While another one is open, a call answers null at once and shows nothing.
export type ModDialogs = {
  // The chosen item's id, or null on Esc.
  choose(options: ModChooseOptions): Promise<string | null>
  confirm(options: ModConfirmOptions): Promise<boolean | null>
  // The text, or null on Esc.
  input(options: ModInputOptions): Promise<string | null>
  // Resolves when the dialog closes.
  open(options: ModDialogOptions): { close(): void; closed: Promise<void> }
}

// A tool call in the chat, as a row renderer sees it.
export type ModToolInfo = {
  // The full name, like "Bash" or "mcp__mod-terminal__terminal_read".
  readonly name: string
  // The name without the MCP prefix: "terminal_read".
  readonly short: string
  // The MCP server the tool came from, like "mod-terminal"; null for Claude Code's own tools.
  readonly source: string | null
  readonly input: unknown
  readonly result: string
  readonly status: "running" | "done" | "error" | "stopped"
  // The app's one-line summary of the input, like a file path or a command.
  readonly summary: string
}

// What a mod draws in a tool row; a part left out is drawn by the app.
export type ModRowParts = {
  // In place of the tool's name.
  title?: string
  // In place of the summary next to the name.
  text?: string
  // In place of the result lines under the row.
  body?: (props: { width: number; expanded: boolean }) => JSX.Element
}

// Null leaves the row to the next mod, and in the end to the app.
export type ModRowRenderer = { render(tool: ModToolInfo): ModRowParts | null }

// A fenced code block in Claude's reply, drawn once it is finished.
export type ModFenceBlock = { code: string; lang: string }

export type ModFence = {
  // The info strings it draws, like ["csv", "tsv"], or a test on one.
  langs: string[] | ((lang: string) => boolean)
  // False leaves a block it cannot draw to the next mod, and in the end to the app.
  accept?(block: ModFenceBlock): boolean
  view: (props: ModFenceBlock & { width: number }) => JSX.Element
}

// The parts of the screen a mod may wrap, with what each one is given.
export type ModOverridePoints = {
  "user-message": Readonly<UserMessageRowProps>
  thinking: Readonly<ThinkingRowProps>
  "turn-end": Readonly<TurnEndRowProps>
  "system-row": Readonly<SystemRowProps>
  prompt: Readonly<PromptBarProps>
  "status-line": Readonly<StatusLineProps>
}

// Gets the part as it is drawn now, the original or an earlier mod's wrap, and returns what to draw instead. A point's
// props only ever gain fields.
export type ModWrap<P extends ModOverridePoints[keyof ModOverridePoints]> = (Original: Component<P>) => Component<P>

export type ModOverrides = {
  wrap<K extends keyof ModOverridePoints>(point: K, wrap: ModWrap<ModOverridePoints[K]>): Dispose
  // Runs on a message the user typed, not on /commands or ! shell commands. Returns the text to send, or null to keep
  // the message in the prompt.
  beforeSend(change: (text: string) => string | null): Dispose
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
  readonly dialogs: ModDialogs
  readonly overrides: ModOverrides
  readonly fences: { add(fence: ModFence): Dispose }
  readonly toolRows: { add(renderer: ModRowRenderer): Dispose }
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

export { Code, Diff, Rule, theme } from "./kit.tsx"
export { apiVersion } from "./version.ts"
