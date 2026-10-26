import { realpathSync } from "node:fs"
import { createSignal } from "solid-js"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { setSetting, settings } from "../session/settings.ts"
import { createModHost } from "./host.ts"
import { onModError, onModNotify } from "./registry.ts"
import { linkRuntime } from "./runtime.ts"

export const mods = createModHost({
  folder: configPath("mods"),
  disabled: () => settings.disabledMods,
  saveDisabled: (ids) => setSetting("disabledMods", ids),
})

onModError((mod, error) => mods.fail(mod, error))

function real(folder: string): string {
  try {
    return realpathSync(folder)
  } catch {
    return folder
  }
}

// The running mod whose files appear in an error's stack, for errors thrown where no mod is known, like a mouse handler.
export function modOfError(error: unknown): string | null {
  const stack = error instanceof Error ? (error.stack ?? "") : ""
  const entry = mods.entries.find(
    (candidate) =>
      candidate.status === "on" &&
      (stack.includes(`${candidate.folder}/`) || stack.includes(`${real(candidate.folder)}/`)),
  )
  return entry?.id ?? null
}

// `problem` is false for the plain "mods are off" line.
export type ModNotice = { text: string; problem: boolean }

const [modNotice, setModNotice] = createSignal<ModNotice | null>(null)
export { modNotice }
export const clearModNotice = () => setModNotice(null)

onModNotify((mod, text, level) => {
  const name = mods.entries.find((entry) => entry.id === mod)?.manifest?.name ?? mod
  setModNotice({ text: `${name}: ${text}`, problem: level !== "info" })
})

export async function startMods(off: boolean): Promise<void> {
  if (off) {
    setModNotice({ text: "Mods are off (--no-mods)", problem: false })
    return
  }
  const failed: string[] = []
  const stop = mods.onFailure(({ id }) => failed.push(id))
  mods.discover()
  if (mods.entries.length > 0) linkRuntime(mods.folder)
  await mods.loadAll()
  stop()
  if (failed.length === 1) setModNotice({ text: `Mod ${failed[0]} failed · /mods`, problem: true })
  else if (failed.length > 1) setModNotice({ text: `${failed.length} mods failed · /mods`, problem: true })
  for (const entry of mods.entries) log.info(`mod ${entry.id}: ${entry.status}`, entry.problem ?? undefined)
  mods.onFailure(({ id, late }) => {
    if (late) setModNotice({ text: `Mod ${id} failed and was turned off · /mods`, problem: true })
  })
}
