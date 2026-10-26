import { join } from "node:path"
import { log } from "../../log/log.ts"
import { editedLocally, listedEntry, modFolders } from "./checks.ts"
import { installAt } from "./install.ts"
import { readCachedList, refreshList } from "./list.ts"
import { readRecord } from "./record.ts"

const DAY_MS = 24 * 60 * 60 * 1000

// Fetches the list when the cached one is a day old, then moves each listed mod to the list's commit. The running
// copy is left alone; the next start loads the new files. Unlisted, local and locally edited mods are not touched.
export async function autoUpdate(
  mods: string,
  updated: (id: string, version: string) => void,
  now = Date.now,
): Promise<void> {
  const cached = readCachedList()
  let list = cached?.list ?? null
  if (!cached || now() - cached.fetchedAt >= DAY_MS) {
    const fetched = await refreshList(now())
    if (fetched.ok) list = fetched.list
    else log.info("mod list not fetched", fetched.problem)
  }
  if (!list) return
  for (const id of modFolders(mods)) {
    const record = readRecord(mods, id)
    if (!record?.listed) continue
    const entry = listedEntry(list, id)
    if (typeof entry === "string" || entry.sha === record.sha) continue
    if (editedLocally(join(mods, id), record)) {
      log.info(`mod ${id}: edited locally, not updated to ${entry.version}`)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- one install at a time
    const result = await installAt({ ...entry, listed: true }, mods)
    if (result.ok) updated(id, result.record.version)
    else log.warn(`mod ${id}: update to ${entry.version} failed`, result.problem)
  }
}
