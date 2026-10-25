import { createSignal } from "solid-js"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { setSetting, settings } from "../session/settings.ts"
import { createModHost } from "./host.ts"
import { linkRuntime } from "./runtime.ts"

export const mods = createModHost({
  folder: configPath("mods"),
  disabled: () => settings.disabledMods,
  saveDisabled: (ids) => setSetting("disabledMods", ids),
})

// `problem` is false for the plain "mods are off" line.
export type ModNotice = { text: string; problem: boolean }

const [modNotice, setModNotice] = createSignal<ModNotice | null>(null)
export { modNotice }
export const clearModNotice = () => setModNotice(null)

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
