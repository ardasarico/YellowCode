import type { KeyEvent } from "@opentui/core"
import { type Accessor, createSignal, type Signal, untrack } from "solid-js"
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
  ModFence,
  ModInputOptions,
  ModOverridePoints,
  ModRowParts,
  ModRowRenderer,
  ModKey,
  ModPane,
  ModPaneOptions,
  ModSectionOptions,
  ModSession,
  ModStorage,
  ModTool,
  ModToolCall,
  ModWrap,
} from "./api.ts"
import { type KeyBinding, parseKey } from "./keys.ts"
import { readAppValue, writeAppValue } from "./storage.ts"

// What every running mod added, so the app can show and run it and /mods can count it.
export type Owned<T> = T & { mod: string }
type RegisteredKey = Owned<ModKey & { binding: KeyBinding }>

const [commands, setCommands] = createSignal<Owned<ModCommand>[]>([])
const [keys, setKeys] = createSignal<RegisteredKey[]>([])
const [tools, setTools] = createSignal<Owned<ModTool>[]>([])
export { commands as modCommands, keys as modKeys, tools as modTools }

// MCP connection errors of mod servers, by server name, for /mods.
const [serverErrors, setServerErrors] = createSignal<Record<string, string>>({})
export { serverErrors as modServerErrors, setServerErrors as setModServerErrors }

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

// The mods in load order. A mod that reloads registers again; its things go back to its place, not to the end.
let loadOrder: readonly string[] = []
export const setLoadOrder = (ids: readonly string[]) => (loadOrder = ids)

function rank(mod: string): number {
  const index = loadOrder.indexOf(mod)
  return index < 0 ? loadOrder.length : index
}

function placed<T extends { mod: string }>(list: T[], item: T): T[] {
  const after = list.findLastIndex((other) => rank(other.mod) <= rank(item.mod))
  return [...list.slice(0, after + 1), item, ...list.slice(after + 1)]
}

function adder<T extends { mod: string }>(set: (update: (list: T[]) => T[]) => void) {
  return (item: T): Dispose => {
    set((list) => placed(list, item))
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

// A pane with a title is named: "pane Terminal".
function paneWords(mod: string): string[] {
  const own = panes().filter((pane) => pane.mod === mod)
  const titled = own.flatMap((pane) => (pane.title ? [`pane ${pane.title}`] : []))
  return [...titled, ...count(own.length - titled.length, "pane")]
}

export function counts(mod: string): string[] {
  return [
    ...paneWords(mod),
    ...count(commands().filter((command) => command.mod === mod).length, "command"),
    ...count(keys().filter((key) => key.mod === mod).length, "shortcut"),
    ...count(tools().filter((tool) => tool.mod === mod).length, "tool"),
    ...count(sections().filter((section) => section.mod === mod).length, "section"),
    ...count(rowRenderers().filter((renderer) => renderer.mod === mod).length, "row renderer"),
    ...count(fences().filter((fence) => fence.mod === mod).length, "fence"),
    ...count(wrapCount(mod) + senders().filter((send) => send.mod === mod).length, "override"),
  ]
}

export type RegisteredPane = Owned<ModPaneOptions> & { key: string; visible: Accessor<boolean> }

const [panes, setPanes] = createSignal<RegisteredPane[]>([])
const [focusedPane, setFocusedPane] = createSignal<string | null>(null)
const [shown, setShown] = createSignal<ReadonlySet<string>>(new Set())
const keySinks = new Map<string, (key: KeyEvent) => void>()
export { panes as modPanes, focusedPane, setFocusedPane }

export function setPaneKeys(pane: string, handler: (key: KeyEvent) => void): Dispose {
  keySinks.set(pane, handler)
  return () => {
    if (keySinks.get(pane) === handler) keySinks.delete(pane)
  }
}
export const paneKeys = (pane: string) => keySinks.get(pane)

const pasteSinks = new Map<string, (text: string) => void>()
export function setPanePaste(pane: string, handler: (text: string) => void): Dispose {
  pasteSinks.set(pane, handler)
  return () => {
    if (pasteSinks.get(pane) === handler) pasteSinks.delete(pane)
  }
}
export const panePaste = (pane: string) => pasteSinks.get(pane)

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
  // The app reads these while laying out; a throw turns the mod off and the pane falls back until it is gone.
  const read =
    <T>(get: () => T, fallback: T) =>
    () => {
      try {
        return get()
      } catch (error) {
        queueMicrotask(() => failure(mod, error))
        return fallback
      }
    }
  const entry: RegisteredPane = {
    ...options,
    position: read(options.position, "bottom"),
    size: read(options.size, 0),
    mod,
    key,
    visible: () => shown().has(key),
  }
  setPanes((list) =>
    placed(
      list.filter((pane) => pane.key !== key),
      entry,
    ),
  )
  const dispose = () => {
    setVisible(key, false)
    keySinks.delete(key)
    pasteSinks.delete(key)
    setPanes((list) => list.filter((other) => other !== entry))
  }
  const focus = () => {
    setVisible(key, true)
    setFocusedPane(key)
  }
  const pane: ModPane = {
    show: () => setVisible(key, true),
    hide: () => setVisible(key, false),
    focus,
    toggle: () => (entry.visible() ? setVisible(key, false) : focus()),
    visible: entry.visible,
    focused: () => focusedPane() === key,
    remove: dispose,
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
  const stored = () => openStates.safeParse(readAppValue(storage, "sections")).data ?? {}
  const [open, setOpenSignal] = createSignal(stored()[options.id] ?? true)
  const entry: RegisteredSection = {
    ...options,
    mod,
    key: `${mod}/${options.id}`,
    open,
    setOpen(value) {
      setOpenSignal(value)
      writeAppValue(storage, "sections", { ...stored(), [options.id]: value })
    },
  }
  setSections((list) =>
    placed(
      list.filter((section) => section.key !== entry.key),
      entry,
    ),
  )
  return () => setSections((list) => list.filter((section) => section !== entry))
}

type Listeners = { [E in keyof ModEvents]: Set<{ mod: string; handler: (data: ModEvents[E]) => void }> }
const listeners: Listeners = {
  "tool-done": new Set(),
  "turn-end": new Set(),
  focus: new Set(),
  "message-sent": new Set(),
  "model-changed": new Set(),
}

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
  // A handler's reads must not become dependencies of the app effect that emitted.
  untrack(() => {
    for (const listener of set) guarded(listener.mod, () => listener.handler(data))
  })
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

// Until the app has drawn, nothing could show a dialog; a setup awaiting one would wait forever.
let appShown = false
export const setAppShown = (value: boolean) => (appShown = value)

const canShow = () => appShown && dialog() === null && !appDialogOpen

function request(mod: string, what: Request): Promise<unknown> {
  if (!canShow()) return Promise.resolve(null)
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
      const accepted = canShow()
      const closed = request(mod, { kind: "open", options }).then(() => undefined)
      return {
        shown: accepted,
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
export function rowPartsFor(tool: ModToolCall): { mod: string; parts: ModRowParts } | null {
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

const [fences, setFences] = createSignal<Owned<ModFence>[]>([])
export const addFence = adder<Owned<ModFence>>(setFences)

// The first mod, in load order, that draws a finished block in this language.
export function fenceFor(lang: string, code: string): Owned<ModFence> | null {
  const name = lang.trim().toLowerCase()
  for (const fence of fences()) {
    try {
      const takes = Array.isArray(fence.langs)
        ? fence.langs.some((taken) => taken.toLowerCase() === name)
        : fence.langs(name)
      if (takes && (fence.accept?.({ code, lang: name }) ?? true)) return fence
    } catch (error) {
      queueMicrotask(() => failure(fence.mod, error))
    }
  }
  return null
}

type WrapEntry<K extends keyof ModOverridePoints> = { mod: string; wrap: ModWrap<ModOverridePoints[K]> }
type Wraps = { [K in keyof ModOverridePoints]: Signal<WrapEntry<K>[]> }
function wrapList<K extends keyof ModOverridePoints>(): Signal<WrapEntry<K>[]> {
  const [list, setList] = createSignal<WrapEntry<K>[]>([])
  return [list, setList]
}
const wraps: Wraps = {
  "user-message": wrapList(),
  thinking: wrapList(),
  "turn-end": wrapList(),
  "system-row": wrapList(),
  prompt: wrapList(),
  "status-line": wrapList(),
}

export function addWrap<K extends keyof ModOverridePoints>(
  mod: string,
  point: K,
  wrap: ModWrap<ModOverridePoints[K]>,
): Dispose {
  const entry: WrapEntry<K> = { mod, wrap }
  const [, setList]: Wraps[K] = wraps[point]
  setList((list) => placed(list, entry))
  return () => setList((list) => list.filter((other) => other !== entry))
}

// In load order: the first wraps the original, a later one wraps that.
export function wrapsOf<K extends keyof ModOverridePoints>(point: K): WrapEntry<K>[] {
  const [list]: Wraps[K] = wraps[point]
  return list()
}

function wrapCount(mod: string): number {
  const lists: Accessor<{ mod: string }[]>[] = Object.values(wraps).map(([list]) => list)
  return lists.flatMap((list) => list()).filter((wrap) => wrap.mod === mod).length
}

type Sender = { mod: string; change: (text: string) => string | null }
const [senders, setSenders] = createSignal<Sender[]>([])
export const addSender = adder<Sender>(setSenders)

// The text after every mod's before-send, in load order, or null when one of them stops the message. A mod that throws
// is turned off and skipped.
export function beforeSend(text: string): string | null {
  let current = text
  for (const sender of senders()) {
    try {
      const next: unknown = sender.change(current)
      if (next === null) return null
      if (typeof next !== "string") throw new Error("before-send must return the text or null")
      current = next
    } catch (error) {
      queueMicrotask(() => failure(sender.mod, error))
    }
  }
  return current
}

// What the app lends mods once it is drawn: the clipboard, opening things, the prompt and the session.
export type AppBridge = {
  copy(text: string): Promise<boolean>
  open(target: string): Promise<boolean>
  insert(text: string): void
  session: ModSession
}

const [bridge, setBridge] = createSignal<AppBridge | null>(null)
export { setBridge as setAppBridge }
export const appBridge = bridge

let notify: (mod: string, text: string, level: "info" | "warning" | "error") => void = () => {}
export const onModNotify = (handler: typeof notify) => (notify = handler)
export const modNotify = (mod: string, text: string, level: "info" | "warning" | "error") => notify(mod, text, level)
