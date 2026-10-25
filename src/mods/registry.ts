import { createSignal } from "solid-js"
import { log } from "../log/log.ts"
import type { Dispose, ModCommand, ModKey } from "./api.ts"
import { type KeyBinding, parseKey } from "./keys.ts"

// What every running mod added, so the app can show and run it and /mods can count it.
export type Owned<T> = T & { mod: string }
export type RegisteredKey = Owned<ModKey & { binding: KeyBinding }>

const [commands, setCommands] = createSignal<Owned<ModCommand>[]>([])
const [keys, setKeys] = createSignal<RegisteredKey[]>([])
export { commands as modCommands, keys as modKeys }

let failure: (mod: string, error: unknown) => void = (mod, error) => log.warn(`mod ${mod} failed`, error)
export const onModError = (handler: typeof failure) => (failure = handler)

// Runs a mod's code; a throw or a rejected promise turns the mod off.
export function guarded(mod: string, run: () => unknown): void {
  try {
    const result = run()
    if (result instanceof Promise) result.catch((error: unknown) => failure(mod, error))
  } catch (error) {
    failure(mod, error)
  }
}

function adder<T>(set: (update: (list: T[]) => T[]) => void) {
  return (item: T): Dispose => {
    set((list) => [...list, item])
    return () => set((list) => list.filter((entry) => entry !== item))
  }
}

export const addCommand = adder<Owned<ModCommand>>(setCommands)

const pushKey = adder<RegisteredKey>(setKeys)
export function addKey(mod: string, key: ModKey): Dispose {
  const binding = parseKey(key.key)
  if (!binding) throw new Error(`"${key.key}" is not a key`)
  return pushKey({ ...key, binding, mod })
}

const count = (n: number, word: string) => (n === 0 ? [] : [`${n} ${word}${n === 1 ? "" : "s"}`])

export function counts(mod: string): string[] {
  return [
    ...count(commands().filter((command) => command.mod === mod).length, "command"),
    ...count(keys().filter((key) => key.mod === mod).length, "shortcut"),
  ]
}
