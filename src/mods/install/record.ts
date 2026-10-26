import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { parseJson } from "../../protocol/json.ts"

// Outside the mod's own folder, so the mod's tree hash stays clean. The host skips dot folders.
const RECORDS = ".installed"

const InstallRecord = z.object({
  source: z.string(),
  sha: z.string(),
  treeHash: z.string(),
  version: z.string(),
  listed: z.boolean(),
  installedAt: z.string(),
})

export type InstallRecord = z.output<typeof InstallRecord>

export const recordPath = (modsFolder: string, id: string) => join(modsFolder, RECORDS, `${id}.json`)

export function readRecord(modsFolder: string, id: string): InstallRecord | null {
  let text: string
  try {
    text = readFileSync(recordPath(modsFolder, id), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  if (!json.ok) return null
  const parsed = InstallRecord.safeParse(json.value)
  return parsed.success ? parsed.data : null
}

export function writeRecord(modsFolder: string, id: string, record: InstallRecord): void {
  const path = recordPath(modsFolder, id)
  mkdirSync(join(modsFolder, RECORDS), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2))
  renameSync(`${path}.tmp`, path)
}
