import type { KeyEvent } from "@opentui/core"
import { type Accessor, createSignal } from "solid-js"
import { log } from "../log/log.ts"
import type { Dispose, ModCommand, ModKey, ModPane, ModPaneOptions, ModTool } from "./api.ts"
import { type KeyBinding, parseKey } from "./keys.ts"

// What every running mod added, so the app can show and run it and /mods can count it.
export type Owned<T> = T & { mod: string }
export type RegisteredKey = Owned<ModKey & { binding: KeyBinding }>

const [commands, setCommands] = createSignal<Owned<ModCommand>[]>([])
const [keys, setKeys] = createSignal<RegisteredKey[]>([])
const [tools, setTools] = createSignal<Owned<ModTool>[]>([])
export { commands as modCommands, keys as modKeys, tools as modTools }

let failure: (mod: string, error: unknown) => void = (mod, error) => log.warn(`mod ${mod} failed`, error)
export const onModError = (handler: typeof failure) => (failure = handler)
export const reportModError = (mod: string, error: unknown) => failure(mod, error)

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
export const addTool = adder<Owned<ModTool>>(setTools)

const pushKey = adder<RegisteredKey>(setKeys)
export function addKey(mod: string, key: ModKey): Dispose {
  const binding = parseKey(key.key)
  if (!binding) throw new Error(`"${key.key}" is not a key`)
  return pushKey({ ...key, binding, mod })
}

const count = (n: number, word: string) => (n === 0 ? [] : [`${n} ${word}${n === 1 ? "" : "s"}`])

export function counts(mod: string): string[] {
  return [
    ...count(panes().filter((pane) => pane.mod === mod).length, "pane"),
    ...count(commands().filter((command) => command.mod === mod).length, "command"),
    ...count(keys().filter((key) => key.mod === mod).length, "shortcut"),
    ...count(tools().filter((tool) => tool.mod === mod).length, "tool"),
  ]
}

export type RegisteredPane = Owned<ModPaneOptions> & { key: string; visible: Accessor<boolean> }

const [panes, setPanes] = createSignal<RegisteredPane[]>([])
const [focusedPane, setFocusedPane] = createSignal<string | null>(null)
const [shown, setShown] = createSignal<ReadonlySet<string>>(new Set())
const keySinks = new Map<string, (key: KeyEvent) => void>()
export { panes as modPanes, focusedPane, setFocusedPane }

export const setPaneKeys = (pane: string, handler: (key: KeyEvent) => void) => keySinks.set(pane, handler)
export const paneKeys = (pane: string) => keySinks.get(pane)

function setVisible(pane: string, visible: boolean): void {
  setShown((current) => {
    const next = new Set(current)
    if (visible) next.add(pane)
    else next.delete(pane)
    return next
  })
  if (!visible && focusedPane() === pane) setFocusedPane(null)
}

export function addPane(mod: string, options: ModPaneOptions): { pane: ModPane; dispose: Dispose } {
  const key = `${mod}/${options.id}`
  const entry: RegisteredPane = { ...options, mod, key, visible: () => shown().has(key) }
  setPanes((list) => [...list.filter((pane) => pane.key !== key), entry])
  const pane: ModPane = {
    show: () => setVisible(key, true),
    hide: () => setVisible(key, false),
    focus() {
      setVisible(key, true)
      setFocusedPane(key)
    },
    visible: entry.visible,
    focused: () => focusedPane() === key,
  }
  const dispose = () => {
    setVisible(key, false)
    keySinks.delete(key)
    setPanes((list) => list.filter((other) => other !== entry))
  }
  return { pane, dispose }
}
