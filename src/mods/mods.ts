import { realpathSync } from "node:fs"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { setSetting, settings } from "../session/settings.ts"
import { createModHost, type ModAgent, revokedReason } from "./host.ts"
import { autoUpdate } from "./install/auto-update.ts"
import { installAt } from "./install/install.ts"
import { type ListedMod, type ModList, readCachedList, refreshList } from "./install/list.ts"
import { onModError, onModNotify } from "./registry.ts"
import { linkRuntime } from "./runtime.ts"

export const mods = createModHost({
  folder: configPath("mods"),
  disabled: () => settings.disabledMods,
  saveDisabled: (ids) => setSetting("disabledMods", ids),
  revoked: (id, manifest, record) => revokedReason(readCachedList()?.list.revoked ?? [], id, manifest, record),
})

onModError((mod, error) => mods.fail(mod, error))

function real(folder: string): string {
  try {
    return realpathSync(folder)
  } catch {
    return folder
  }
}

function inFolder(error: unknown, folder: string): boolean {
  const stack = error instanceof Error ? (error.stack ?? "") : ""
  return stack.includes(`${folder}/`) || stack.includes(`${real(folder)}/`)
}

// Whether the error's stack points into the mod's folder.
export function raisedByMod(id: string, error: unknown): boolean {
  const entry = mods.entries.find((candidate) => candidate.id === id)
  return entry !== undefined && inFolder(error, entry.folder)
}

// The running mod whose files appear in an error's stack, for errors thrown where no mod is known, like a mouse handler.
export function modOfError(error: unknown): string | null {
  const entry = mods.entries.find((candidate) => candidate.status === "on" && inFolder(error, candidate.folder))
  return entry?.id ?? null
}

// `problem` is false for the plain "mods are off" line; `error` is a mod's notice at its error level.
export type ModNotice = { text: string; problem: boolean; error?: boolean }

const [modNotice, setModNotice] = createSignal<ModNotice | null>(null)
export { modNotice }
export const clearModNotice = () => setModNotice(null)

onModNotify((mod, text, level) => {
  const name = mods.entries.find((entry) => entry.id === mod)?.manifest?.name ?? mod
  setModNotice({ text: `${name}: ${text}`, problem: level !== "info", error: level === "error" })
})

// The agent the mods loaded for last, and the load of the moment; null while mods are off.
let loadedFor: ModAgent | null = null
let loading = Promise.resolve()

async function loadFor(agent: ModAgent): Promise<void> {
  loadedFor = agent
  // A mod that fails while it loads is reported for its load and for its turn-off; it counts once.
  const failed: string[] = []
  const stop = mods.onFailure(({ id }) => {
    if (!failed.includes(id)) failed.push(id)
  })
  mods.discover(agent)
  if (mods.entries.length > 0) linkRuntime(mods.folder)
  await mods.loadAll()
  stop()
  if (failed.length === 1) setModNotice({ text: `Mod ${failed[0]} did not load · /mods`, problem: true })
  else if (failed.length > 1) setModNotice({ text: `${failed.length} mods did not load · /mods`, problem: true })
  for (const entry of mods.entries) log.info(`mod ${entry.id}: ${entry.status}`, entry.problem ?? undefined)
}

export async function startMods(off: boolean, agent: ModAgent): Promise<void> {
  if (off) {
    setModNotice({ text: "Mods are off (--no-mods)", problem: false })
    return
  }
  await loadFor(agent)
  mods.onFailure(({ id, late }) => {
    if (late) setModNotice({ text: `Mod ${id} failed and was turned off · /mods`, problem: true })
  })
}

// A session of another agent: every mod loads again for it, with its own manifest list and what it takes.
export function modsFor(agent: ModAgent): Promise<void> {
  loading = loading
    .then(() => (loadedFor && loadedFor.id !== agent.id ? loadFor(agent) : undefined))
    .catch((error: unknown) => log.error(`mods did not load for ${agent.id}`, error))
  return loading
}

// The version each mod was updated to on disk since this start; the running copy stays the old one.
const [updatedTo, setUpdatedTo] = createStore<Record<string, string>>({})
export { updatedTo }

export function startModUpdates(off: boolean): void {
  if (off) return
  autoUpdate(mods.folder, (id, version) => {
    log.info(`mod ${id}: updated to ${version} on disk`)
    setUpdatedTo(id, version)
  }).catch((error: unknown) => log.warn("mod updates failed", error))
}

export type ModListState = { list: ModList | null; fetching: boolean; failed: boolean }

const [modList, setModList] = createSignal<ModListState>({ list: null, fetching: false, failed: false })
export { modList }

// The cached list at once, then a fresh one. The Mods tab asks for this each time it opens.
export function refreshModList(): void {
  if (modList().fetching) return
  setModList({ list: readCachedList()?.list ?? null, fetching: true, failed: false })
  const done = (list: ModList | null) =>
    setModList((state) => ({ list: list ?? state.list, fetching: false, failed: list === null }))
  refreshList()
    .then((fetched) => {
      if (!fetched.ok) log.info("mod list not fetched", fetched.problem)
      done(fetched.ok ? fetched.list : null)
    })
    .catch((error: unknown) => {
      log.warn("mod list not fetched", error)
      done(null)
    })
}

// Listed mods installed from the Mods tab since this start; they load on the next one.
const [installedNow, setInstalledNow] = createStore<Record<string, ListedMod>>({})
export { installedNow }

export async function installListed(mod: ListedMod): Promise<void> {
  const result = await installAt({ ...mod, listed: true }, mods.folder)
  if (!result.ok) throw new Error(result.problem)
  log.info(`mod ${mod.id}: installed ${result.record.version}`)
  setInstalledNow(mod.id, mod)
}
