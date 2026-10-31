import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { ClientTool, McpLaunch } from "../agent/agent.ts"
import type { Capabilities } from "../agent/capabilities.ts"
import type { AgentKindId } from "../agent/ids.ts"
import { log } from "../log/log.ts"
import type { DefinedMod, Dispose, ModApi, ModSettingDefinitions, ModTool, ModToolResult } from "./api.ts"
import { compatible, forAgent, incompatibleText, type Manifest, type McpServer, readManifest } from "./manifest.ts"
import {
  addCommand,
  addFence,
  addKey,
  addListener,
  addPane,
  addRowRenderer,
  addSender,
  addSection,
  addTool,
  addWrap,
  guarded,
  appBridge,
  countLoad,
  modDialogs,
  modNotify,
  modTools,
  setLoadOrder,
} from "./registry.ts"
import type { ModList } from "./install/list.ts"
import { type InstallRecord, readRecord } from "./install/record.ts"
import { createSettings, type SettingsHandle } from "./settings.ts"
import { modFacingStorage, modStorage } from "./storage.ts"

// "elsewhere": the mod cannot run on the agent YellowCode runs: the manifest does not list it, or the mod adds tools or
// MCP servers the agent does not take.
export type ModStatus = "on" | "off" | "failed" | "incompatible" | "revoked" | "elsewhere"

const NOT_FOR_AGENT = "not for this agent"

// Each mod's tools are served as the MCP server mod-<id>; its manifest's servers are mod-<id>--<name>.
export const MOD_SERVER_PREFIX = "mod-"

// The agent mods load for, and what it takes from them.
export type ModAgent = { id: AgentKindId; name: string; caps: Pick<Capabilities, "clientTools" | "mcpServers"> }

// A mod with no install record was put in the folder by hand.
export type ModSource = "listed" | "unlisted" | "local"

export type ModError = { message: string; stack: string | null }

export type ModEntry = {
  id: string
  folder: string
  manifest: Manifest | null
  status: ModStatus
  source: ModSource
  // Why it did not load, when that is not an error thrown by the mod.
  problem: string | null
  error: ModError | null
  loadMs: number | null
  // What the mod declared the last time it loaded.
  settings: ModSettingDefinitions | null
}

// `late` is a failure after the mod was running, which turns it off.
export type ModFailure = { id: string; late: boolean }

export type ModHost = {
  readonly entries: readonly ModEntry[]
  readonly folder: string
  // The agent is the one the mods load for until the next discover.
  discover(agent: ModAgent): void
  loadAll(): Promise<void>
  setEnabled(id: string, on: boolean): Promise<void>
  // Runs every mod's cleanups, on quit.
  unloadAll(): void
  reload(id: string): Promise<void>
  fail(id: string, error: unknown): void
  // Every running mod's tools, each mod's under the server mod-<id>.
  clientTools(): ClientTool[]
  // The settings of a running mod.
  settings(id: string): SettingsHandle | null
  // A running mod's manifest servers by the name the agent gets, mod-<id>--<name>.
  servers(id: string): Record<string, McpServer>
  // Every running mod's manifest servers, for an agent that takes them as launches.
  launches(): McpLaunch[]
  onFailure(listener: (failure: ModFailure) => void): () => void
}

const launchOf = (name: string, server: McpServer): McpLaunch =>
  "url" in server
    ? { name, url: server.url, headers: server.headers ?? {} }
    : { name, command: server.command, args: server.args ?? [], env: server.env ?? {} }

// A manifest server writes ${modDir} for the mod's own folder, so it can run a script the mod ships.
function inFolder(server: McpServer, folder: string): McpServer {
  const fill = (text: string) => text.replaceAll("${modDir}", folder)
  const values = (record: Record<string, string> | undefined) =>
    record && Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]))
  if ("url" in server) return { ...server, url: fill(server.url) }
  return { ...server, command: fill(server.command), args: server.args?.map(fill), env: values(server.env) }
}

function textOf(result: ModToolResult): { text: string; error: boolean } {
  const { text, isError } = typeof result === "string" ? { text: result, isError: false } : result
  return { text, error: isError === true }
}

// A throwing tool is an error the agent reads; it does not turn the mod off.
function clientTool(tool: ModTool & { mod: string }): ClientTool {
  const { mod, name, annotations } = tool
  return {
    server: `${MOD_SERVER_PREFIX}${mod}`,
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: annotations
      ? { readOnly: annotations.readOnlyHint, destructive: annotations.destructiveHint, title: annotations.title }
      : null,
    async run(input) {
      try {
        return textOf(await tool.run(input))
      } catch (error) {
        log.warn(`mod ${mod}: tool ${name} failed`, error)
        return { text: error instanceof Error ? error.message : String(error), error: true }
      }
    },
  }
}

// What the running mods added as tools, as the agent gets them.
export const modClientTools = (): ClientTool[] => modTools().map(clientTool)

type Running = { disposers: (() => void)[]; cleanup: Dispose | null; settings: SettingsHandle | null }

const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

// What defineMod returns, told apart from any other default export.
function isDefinedMod(value: unknown): value is DefinedMod {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.for("yellowcode.mod") in value &&
    "setup" in value &&
    typeof value.setup === "function"
  )
}

function asError(error: unknown): ModError {
  if (error instanceof Error) return { message: String(error), stack: error.stack ?? null }
  return { message: String(error), stack: null }
}

// statSync follows a linked mod folder, which readdir reports as a symlink. A broken link is skipped.
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function modFolders(folder: string): string[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  return names
    .filter((name) => name !== "node_modules" && !name.startsWith(".") && isFolder(join(folder, name)))
    .toSorted()
}

// Listed mods match by version, unlisted ones by commit SHA. A local mod has neither, so only a revoke of every
// version reaches it.
export function revokedReason(
  revoked: ModList["revoked"],
  id: string,
  manifest: Manifest,
  record: InstallRecord | null,
): string | null {
  const match = revoked.find((entry) => {
    if (entry.id !== id) return false
    if (!record) return entry.versions === "all"
    if (!record.listed) return entry.shas?.includes(record.sha) ?? false
    return entry.versions === "all" || entry.versions.includes(manifest.version)
  })
  return match?.reason ?? null
}

// YellowCode waits for every setup before it draws, so one that hangs would keep the window from opening.
const SETUP_LIMIT_MS = 5000

function withinLimit<T>(value: T | Promise<T>, limitMs: number, late: (value: T) => void): Promise<T> | T {
  if (!(value instanceof Promise)) return value
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void value.then(late, () => {})
      reject(new Error(`setup did not finish in ${limitMs / 1000} s`))
    }, limitMs)
  })
  return Promise.race([value, limit]).finally(() => clearTimeout(timer))
}

export function createModHost(options: {
  folder: string
  // How long a setup may take; 5 s by default.
  setupLimitMs?: number
  disabled: () => readonly string[]
  saveDisabled: (ids: string[]) => void
  // Why a mod was taken off the list, or null when it may load.
  revoked?: (id: string, manifest: Manifest, record: InstallRecord | null) => string | null
}): ModHost {
  const [entries, setEntries] = createStore<ModEntry[]>([])
  const running = new Map<string, Running>()
  const listeners = new Set<(failure: ModFailure) => void>()
  let imports = 0
  let agent: ModAgent | null = null

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
    const record = readRecord(options.folder, id)
    const source: ModSource = !record ? "local" : record.listed ? "listed" : "unlisted"
    const base = { id, folder, source, error: null, loadMs: null, settings: entries[indexOf(id)]?.settings ?? null }
    if (!read.ok) return { ...base, manifest: null, status: "failed", problem: read.problem }
    const { manifest } = read
    const reason = options.revoked?.(id, manifest, record) ?? null
    if (reason !== null) return { ...base, manifest, status: "revoked", problem: `Revoked: ${reason}` }
    if (!compatible(manifest))
      return { ...base, manifest, status: "incompatible", problem: incompatibleText(manifest.api) }
    if (!agent || !forAgent(manifest, agent.id))
      return { ...base, manifest, status: "elsewhere", problem: NOT_FOR_AGENT }
    if (Object.keys(manifest.mcpServers ?? {}).length > 0 && agent.caps.mcpServers === "none")
      return { ...base, manifest, status: "elsewhere", problem: `${agent.name} takes no MCP servers from mods` }
    const off = options.disabled().includes(id)
    return { ...base, manifest, status: off ? "off" : "on", problem: null }
  }

  function disposeState(id: string, state: Running): void {
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

  function unload(id: string): void {
    const state = running.get(id)
    if (!state) return
    running.delete(id)
    disposeState(id, state)
  }

  async function load(id: string): Promise<void> {
    const entry = entries[indexOf(id)]
    if (!entry?.manifest || entry.status !== "on") return
    const file = join(entry.folder, entry.manifest.entry)
    const state: Running = { disposers: [], cleanup: null, settings: null }
    running.set(id, state)
    countLoad(id)
    // Turned off or reloaded while setup was still awaiting.
    const stale = () => running.get(id) !== state
    const own = (disposer: Dispose): Dispose => {
      if (stale()) disposer()
      else state.disposers.push(disposer)
      return disposer
    }
    const started = performance.now()
    try {
      const module: unknown = await import(`${file}?v=${++imports}`)
      const definition = typeof module === "object" && module !== null && "default" in module ? module.default : null
      if (stale()) return
      if (!isDefinedMod(definition)) {
        unload(id)
        update(id, { status: "failed", problem: `${entry.manifest.entry} has no default defineMod export` })
        return
      }
      const storage = modStorage(id)
      const settings = createSettings(id, definition.settings ?? {}, storage)
      state.settings = settings
      update(id, { settings: definition.settings ?? {} })
      const dialogs = modDialogs(id)
      own(dialogs.dispose)
      const api: ModApi = {
        id,
        storage: modFacingStorage(storage),
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
        tools: {
          add(tool) {
            if (!TOOL_NAME.test(tool.name)) throw new Error(`"${tool.name}" is not a tool name`)
            if (modTools().some((other) => other.mod === id && other.name === tool.name))
              throw new Error(`tool "${tool.name}" is already added`)
            if (agent?.caps.clientTools === "none") {
              unload(id)
              update(id, { status: "elsewhere", problem: `${agent.name} takes no tools from mods`, loadMs: null })
              return () => {}
            }
            return own(addTool({ ...tool, mod: id }))
          },
        },
        sidebar: { add: (section) => own(addSection(id, section, storage)) },
        dialogs: dialogs.dialogs,
        overrides: {
          wrap: (point, wrap) => own(addWrap(id, point, wrap)),
          beforeSend: (change) => own(addSender({ mod: id, change })),
        },
        fences: { add: (fence) => own(addFence({ ...fence, mod: id })) },
        toolRows: { add: (renderer) => own(addRowRenderer({ render: (tool) => renderer.render(tool), mod: id })) },
        events: { on: (event, handler) => own(addListener(id, event, handler)) },
        panes: {
          add(paneOptions) {
            const { pane, dispose } = addPane(id, paneOptions)
            own(dispose)
            return pane
          },
        },
        onDispose: (disposer) => void own(disposer),
        cwd: process.cwd(),
        notify: (text, notifyOptions) => {
          if (!stale()) modNotify(id, text, notifyOptions?.level ?? "info")
        },
        clipboard: { write: async (text) => (await appBridge()?.copy(text)) ?? false },
        open: async (target) => (await appBridge()?.open(target)) ?? false,
        session: {
          model: () => appBridge()?.session.model() ?? null,
          id: () => appBridge()?.session.id() ?? null,
          running: () => appBridge()?.session.running() ?? false,
          mode: () => appBridge()?.session.mode() ?? null,
        },
        prompt: { insert: (text) => appBridge()?.insert(text) },
      }
      // Effects and memos made in setup belong to the mod and end with it. Code after an await in setup has no owner.
      const setup = createRoot((disposeRoot) => {
        own(disposeRoot)
        return definition.setup(api)
      })
      const cleanup = await withinLimit(setup, options.setupLimitMs ?? SETUP_LIMIT_MS, (late) => {
        // The mod failed already; a cleanup its setup returns after all still runs.
        if (typeof late === "function") late()
      })
      if (typeof cleanup === "function") state.cleanup = cleanup
      if (stale()) {
        disposeState(id, { disposers: [], cleanup: state.cleanup, settings: null })
        return
      }
      const loadMs = Math.round(performance.now() - started)
      update(id, { loadMs, error: null, problem: null })
      log.info(`mod ${id} loaded in ${loadMs} ms`)
    } catch (error) {
      if (stale()) return log.warn(`mod ${id} failed at a setup that was already replaced`, error)
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

  function serversOf(id: string): Record<string, McpServer> {
    const entry = entries[indexOf(id)]
    if (entry?.status !== "on") return {}
    const servers: Record<string, McpServer> = {}
    // Ids never hold "--", so a manifest server cannot take another mod's name.
    for (const [name, config] of Object.entries(entry.manifest?.mcpServers ?? {}))
      servers[`${MOD_SERVER_PREFIX}${id}--${name}`] = inFolder(config, entry.folder)
    return servers
  }

  return {
    entries,
    folder: options.folder,
    discover(forMods) {
      agent = forMods
      for (const id of running.keys()) unload(id)
      const ids = modFolders(options.folder)
      setLoadOrder(ids)
      setEntries(ids.map(freshEntry))
    },
    async loadAll() {
      await Promise.all(entries.map((entry) => load(entry.id)))
      for (const entry of entries) {
        if (entry.status === "failed" || entry.status === "incompatible" || entry.status === "revoked")
          emit({ id: entry.id, late: false })
      }
    },
    async setEnabled(id, on) {
      const others = options.disabled().filter((disabled) => disabled !== id)
      options.saveDisabled(on ? others : [...others, id])
      await restart(id)
    },
    reload: restart,
    unloadAll() {
      for (const id of running.keys()) unload(id)
    },
    settings: (id) => running.get(id)?.settings ?? null,
    clientTools: modClientTools,
    servers: serversOf,
    launches() {
      return entries.flatMap((entry) =>
        Object.entries(serversOf(entry.id)).map(([name, server]) => launchOf(name, server)),
      )
    },
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
