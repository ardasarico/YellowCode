import { readdirSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import { createStore } from "solid-js/store"
import { log } from "../log/log.ts"
import { type Cleanup, type Dispose, isDefinedMod, type ModApi, type SettingDefinitions } from "./api.ts"
import { compatible, type Manifest, readManifest } from "./manifest.ts"
import { addCommand, addKey, addPane, guarded } from "./registry.ts"
import { createSettings, type SettingsHandle } from "./settings.ts"
import { modStorage } from "./storage.ts"

export type ModStatus = "on" | "off" | "failed" | "incompatible"

export type ModError = { message: string; stack: string | null }

export type ModEntry = {
  id: string
  folder: string
  manifest: Manifest | null
  status: ModStatus
  // Why it did not load, when that is not an error thrown by the mod.
  problem: string | null
  error: ModError | null
  loadMs: number | null
  // What the mod declared the last time it loaded.
  settings: SettingDefinitions | null
}

// `late` is a failure after the mod was running, which turns it off.
export type ModFailure = { id: string; late: boolean }

export type ModHost = {
  readonly entries: readonly ModEntry[]
  readonly folder: string
  discover(): void
  loadAll(): Promise<void>
  setEnabled(id: string, on: boolean): Promise<void>
  reload(id: string): Promise<void>
  fail(id: string, error: unknown): void
  // The settings of a running mod.
  settings(id: string): SettingsHandle | null
  onFailure(listener: (failure: ModFailure) => void): () => void
}

type Running = { disposers: (() => void)[]; cleanup: Cleanup | null; settings: SettingsHandle | null }

const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/

function asError(error: unknown): ModError {
  if (error instanceof Error) return { message: String(error), stack: error.stack ?? null }
  return { message: String(error), stack: null }
}

function modFolders(folder: string): string[] {
  try {
    // statSync follows a linked mod folder, which readdir reports as a symlink.
    return readdirSync(folder)
      .filter((name) => name !== "node_modules" && !name.startsWith(".") && statSync(join(folder, name)).isDirectory())
      .toSorted()
  } catch {
    return []
  }
}

// Module cache keys are real paths, so a linked folder is matched by where it points.
function forgetModules(folder: string): void {
  const prefix = realpathSync(folder) + sep
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key]
  }
}

export function createModHost(options: {
  folder: string
  disabled: () => readonly string[]
  saveDisabled: (ids: string[]) => void
}): ModHost {
  const [entries, setEntries] = createStore<ModEntry[]>([])
  const running = new Map<string, Running>()
  const listeners = new Set<(failure: ModFailure) => void>()
  let imports = 0

  const indexOf = (id: string) => entries.findIndex((entry) => entry.id === id)
  const update = (id: string, patch: Partial<ModEntry>) => {
    const index = indexOf(id)
    if (index >= 0) setEntries(index, patch)
  }
  const emit = (failure: ModFailure) => {
    for (const listener of listeners) listener(failure)
  }

  function freshEntry(id: string): ModEntry {
    const folder = join(options.folder, id)
    const read = readManifest(folder)
    const base = { id, folder, error: null, loadMs: null, settings: entries[indexOf(id)]?.settings ?? null }
    if (!read.ok) return { ...base, manifest: null, status: "failed", problem: read.problem }
    const { manifest } = read
    if (!compatible(manifest))
      return { ...base, manifest, status: "incompatible", problem: `needs YellowCode ${manifest.yellowcode}` }
    const off = options.disabled().includes(id)
    return { ...base, manifest, status: off ? "off" : "on", problem: null }
  }

  function unload(id: string): void {
    const state = running.get(id)
    if (!state) return
    running.delete(id)
    const steps = state.disposers.toReversed()
    if (state.cleanup) steps.push(state.cleanup)
    for (const step of steps) {
      try {
        step()
      } catch (error) {
        log.warn(`mod ${id}: dispose failed`, error)
      }
    }
  }

  async function load(id: string): Promise<void> {
    const entry = entries[indexOf(id)]
    if (!entry?.manifest || entry.status !== "on") return
    const file = join(entry.folder, entry.manifest.entry)
    const state: Running = { disposers: [], cleanup: null, settings: null }
    running.set(id, state)
    const own = (dispose: Dispose): Dispose => {
      state.disposers.push(dispose)
      return dispose
    }
    const started = performance.now()
    try {
      forgetModules(entry.folder)
      const module: unknown = await import(`${file}?v=${++imports}`)
      const definition = typeof module === "object" && module !== null && "default" in module ? module.default : null
      if (!isDefinedMod(definition)) {
        unload(id)
        update(id, { status: "failed", problem: `${entry.manifest.entry} has no default defineMod export` })
        return
      }
      const storage = modStorage(id)
      const settings = createSettings(id, definition.settings ?? {}, storage)
      state.settings = settings
      update(id, { settings: definition.settings ?? {} })
      const api: ModApi = {
        id,
        storage,
        settings,
        log: {
          info: (message, detail) => log.info(`[mod ${id}] ${message}`, detail),
          warn: (message, detail) => log.warn(`[mod ${id}] ${message}`, detail),
          error: (message, detail) => log.error(`[mod ${id}] ${message}`, detail),
        },
        commands: {
          add(command) {
            if (!COMMAND_NAME.test(command.name)) throw new Error(`"${command.name}" is not a command name`)
            return own(addCommand({ ...command, mod: id, run: (args) => guarded(id, () => command.run(args)) }))
          },
        },
        keys: { add: (key) => own(addKey(id, { ...key, run: () => guarded(id, () => key.run()) })) },
        panes: {
          add(paneOptions) {
            const { pane, dispose } = addPane(id, paneOptions)
            own(dispose)
            return pane
          },
        },
        onDispose: (dispose) => void state.disposers.push(dispose),
      }
      const cleanup = await definition.setup(api)
      if (typeof cleanup === "function") state.cleanup = cleanup
      const loadMs = Math.round(performance.now() - started)
      update(id, { loadMs, error: null, problem: null })
      log.info(`mod ${id} loaded in ${loadMs} ms`)
    } catch (error) {
      unload(id)
      update(id, { status: "failed", error: asError(error), loadMs: null })
      log.warn(`mod ${id} failed at setup`, error)
    }
  }

  async function restart(id: string): Promise<void> {
    unload(id)
    const index = indexOf(id)
    if (index < 0) return
    setEntries(index, freshEntry(id))
    await load(id)
  }

  return {
    entries,
    folder: options.folder,
    discover() {
      for (const id of running.keys()) unload(id)
      setEntries(modFolders(options.folder).map(freshEntry))
    },
    async loadAll() {
      for (const id of entries.map((entry) => entry.id))
        // oxlint-disable-next-line no-await-in-loop -- one at a time, so each load time is the mod's own
        await load(id)
      for (const entry of entries) {
        if (entry.status === "failed" || entry.status === "incompatible") emit({ id: entry.id, late: false })
      }
    },
    async setEnabled(id, on) {
      const others = options.disabled().filter((disabled) => disabled !== id)
      options.saveDisabled(on ? others : [...others, id])
      await restart(id)
    },
    reload: restart,
    settings: (id) => running.get(id)?.settings ?? null,
    fail(id, error) {
      if (!running.has(id)) return
      unload(id)
      update(id, { status: "failed", error: asError(error) })
      log.warn(`mod ${id} failed and was turned off`, error)
      emit({ id, late: true })
    },
    onFailure(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
