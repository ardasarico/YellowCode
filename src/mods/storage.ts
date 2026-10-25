import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import type { ModStorage } from "./api.ts"

function readValues(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  const json = parseJson(text)
  const values = z.record(z.string(), z.unknown()).safeParse(json.ok ? json.value : null)
  if (values.success) return values.data
  log.warn(`mod data ${path} is not a JSON object, starting empty`)
  return {}
}

export function modStorage(id: string): ModStorage {
  const path = configPath(`mod-data/${id}.json`)
  let values: Record<string, unknown> | null = null
  const current = () => (values ??= readValues(path))
  return {
    path,
    get: (key) => current()[key],
    set(key, value) {
      const next = { ...current(), [key]: value }
      const temp = `${path}.${process.pid}.tmp`
      try {
        // A value JSON cannot hold throws here and is not kept.
        const text = `${JSON.stringify(next, null, 2)}\n`
        values = next
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(temp, text)
        renameSync(temp, path)
      } catch (error) {
        rmSync(temp, { force: true })
        log.warn(`cannot save the data of mod ${id}`, error)
      }
    },
  }
}
