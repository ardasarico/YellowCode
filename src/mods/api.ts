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

export type ModApi = {
  readonly id: string
  readonly storage: ModStorage
  readonly log: ModLog
  // Runs when the mod is turned off, reloaded or fails, newest first.
  onDispose(dispose: () => void): void
}

export type Cleanup = () => void

export type ModDefinition = {
  // Keep it light: start timers, sockets and processes on the first event or command, not here.
  setup(mod: ModApi): void | Cleanup | Promise<void | Cleanup>
}

const BRAND = Symbol.for("yellowcode.mod")

export type DefinedMod = ModDefinition & { readonly [BRAND]: true }

export function defineMod(definition: ModDefinition): DefinedMod {
  return { ...definition, [BRAND]: true }
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
