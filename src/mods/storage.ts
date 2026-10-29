import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../json.ts"
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
  const kept = `${path}.bad-${Date.now()}`
  try {
    renameSync(path, kept)
    log.warn(`mod data ${path} is not a JSON object, kept as ${kept} and starting empty`)
  } catch (error) {
    log.warn(`mod data ${path} is not a JSON object, starting empty`, error)
  }
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

// The app keeps a mod's setting values and open sections in the same file, under keys the mod cannot use.
const APP_PREFIX = "__yellowcode."

export function readAppValue(storage: ModStorage, name: "settings" | "sections"): unknown {
  // Before 1.0 these lived under their plain names.
  return storage.get(`${APP_PREFIX}${name}`) ?? storage.get(name)
}

export function writeAppValue(storage: ModStorage, name: "settings" | "sections", value: unknown): void {
  storage.set(`${APP_PREFIX}${name}`, value)
  if (storage.get(name) !== undefined) storage.set(name, undefined)
}

function checkModKey(key: string): void {
  if (key.startsWith(APP_PREFIX)) throw new Error(`storage keys starting with "${APP_PREFIX}" belong to YellowCode`)
}

// What the mod gets as mod.storage.
export function modFacingStorage(storage: ModStorage): ModStorage {
  return {
    path: storage.path,
    get(key) {
      checkModKey(key)
      return storage.get(key)
    },
    set(key, value) {
      checkModKey(key)
      storage.set(key, value)
    },
  }
}
