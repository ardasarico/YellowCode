import type { KeyEvent } from "@opentui/core"
import { type Accessor, createSignal } from "solid-js"
import { z } from "zod"
import { log } from "../log/log.ts"
import type {
  Dispose,
  ModChooseOptions,
  ModCommand,
  ModConfirmOptions,
  ModDialogOptions,
  ModDialogs,
  ModEvents,
  ModInputOptions,
  ModRowParts,
  ModRowRenderer,
  ModKey,
  ModPane,
  ModPaneOptions,
  ModSectionOptions,
  ModStorage,
  ModTool,
  ModToolInfo,
} from "./api.ts"
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
    ...count(sections().filter((section) => section.mod === mod).length, "section"),
    ...count(rowRenderers().filter((renderer) => renderer.mod === mod).length, "row renderer"),
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

export const DEFAULT_SECTION_ORDER = 30

export type RegisteredSection = Owned<ModSectionOptions> & {
  key: string
  open: Accessor<boolean>
  setOpen(open: boolean): void
}

const [sections, setSections] = createSignal<RegisteredSection[]>([])
export { sections as modSections }

const openStates = z.record(z.string(), z.boolean())

// Whether a section is open is kept in its mod's data file, under "sections".
export function addSection(mod: string, options: ModSectionOptions, storage: ModStorage): Dispose {
  const stored = () => openStates.safeParse(storage.get("sections")).data ?? {}
  const [open, setOpenSignal] = createSignal(stored()[options.id] ?? true)
  const entry: RegisteredSection = {
    ...options,
    mod,
    key: `${mod}/${options.id}`,
    open,
    setOpen(value) {
      setOpenSignal(value)
      storage.set("sections", { ...stored(), [options.id]: value })
    },
  }
  setSections((list) => [...list.filter((section) => section.key !== entry.key), entry])
  return () => setSections((list) => list.filter((section) => section !== entry))
}

type Listeners = { [E in keyof ModEvents]: Set<{ mod: string; handler: (data: ModEvents[E]) => void }> }
const listeners: Listeners = { "tool-done": new Set(), "turn-end": new Set(), focus: new Set() }

export function addListener<E extends keyof ModEvents>(
  mod: string,
  event: E,
  handler: (data: ModEvents[E]) => void,
): Dispose {
  const listener = { mod, handler }
  const set: Listeners[E] = listeners[event]
  set.add(listener)
  return () => set.delete(listener)
}

export function emitModEvent<E extends keyof ModEvents>(event: E, data: ModEvents[E]): void {
  const set: Listeners[E] = listeners[event]
  for (const listener of set) guarded(listener.mod, () => listener.handler(data))
}

export type ModDialogRequest = { mod: string; close(answer: unknown): void } & (
  | { kind: "choose"; options: ModChooseOptions }
  | { kind: "confirm"; options: ModConfirmOptions }
  | { kind: "input"; options: ModInputOptions }
  | { kind: "open"; options: ModDialogOptions }
)

const [dialog, setDialog] = createSignal<ModDialogRequest | null>(null)
export { dialog as modDialog }

// Set by the app: whether a dialog is open there.
let appDialogOpen = false
export const setAppDialogOpen = (open: boolean) => (appDialogOpen = open)

type Request = ModDialogRequest extends infer R
  ? R extends ModDialogRequest
    ? Omit<R, "mod" | "close">
    : never
  : never

function request(mod: string, what: Request): Promise<unknown> {
  if (dialog() !== null || appDialogOpen) return Promise.resolve(null)
  return new Promise((resolve) => {
    const entry: ModDialogRequest = {
      ...what,
      mod,
      close(answer: unknown) {
        if (dialog() === entry) setDialog(null)
        resolve(answer)
      },
    }
    setDialog(entry)
  })
}

const answer = <T>(value: unknown, guard: (value: unknown) => value is T): T | null => (guard(value) ? value : null)
const isString = (value: unknown): value is string => typeof value === "string"
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"

// The dialogs of one mod, and a dispose that closes the one it has open.
export function modDialogs(mod: string): { dialogs: ModDialogs; dispose: Dispose } {
  const dialogs: ModDialogs = {
    choose: async (options) => answer(await request(mod, { kind: "choose", options }), isString),
    confirm: async (options) => answer(await request(mod, { kind: "confirm", options }), isBoolean),
    input: async (options) => answer(await request(mod, { kind: "input", options }), isString),
    open(options) {
      const closed = request(mod, { kind: "open", options }).then(() => undefined)
      return {
        closed,
        close() {
          const current = dialog()
          if (current?.mod === mod && current.kind === "open" && current.options === options) current.close(null)
        },
      }
    },
  }
  return {
    dialogs,
    dispose() {
      const current = dialog()
      if (current?.mod === mod) current.close(null)
    },
  }
}

const [rowRenderers, setRowRenderers] = createSignal<Owned<ModRowRenderer>[]>([])
export const addRowRenderer = adder<Owned<ModRowRenderer>>(setRowRenderers)

// The first mod, in load order, that draws this row; one that throws is turned off and the next one asked.
export function rowPartsFor(tool: ModToolInfo): { mod: string; parts: ModRowParts } | null {
  for (const renderer of rowRenderers()) {
    try {
      const parts = renderer.render(tool)
      if (parts) return { mod: renderer.mod, parts }
    } catch (error) {
      queueMicrotask(() => failure(renderer.mod, error))
    }
  }
  return null
}
