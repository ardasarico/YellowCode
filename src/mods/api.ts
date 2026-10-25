// What a mod imports as "yellowcode/mod". Additions only: a mod written against an older version keeps working.

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

export type ModApi<S extends SettingDefinitions = SettingDefinitions> = {
  readonly id: string
  readonly storage: ModStorage
  readonly log: ModLog
  readonly settings: ModSettings<S>
  readonly commands: { add(command: ModCommand): Dispose }
  readonly keys: { add(key: ModKey): Dispose }
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
