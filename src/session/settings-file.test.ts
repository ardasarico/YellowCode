import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJson } from "../protocol/json.ts"
import { DEFAULT_SETTINGS, loadSettings, saveSettings, UNREADABLE_PROBLEM } from "./settings-file.ts"

function fileWith(content: string | null): string {
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-settings-")), "settings.json")
  if (content !== null) writeFileSync(path, content)
  return path
}

test("a missing file gives the defaults and no problem", () => {
  expect(loadSettings(fileWith(null))).toEqual({ settings: DEFAULT_SETTINGS, problem: null, backup: null })
})

const TRUNCATED = '{"theme": "dusk", "sidebar": "auto",'

test("a truncated file keeps the keys it can read, archives the old bytes and writes a valid file", () => {
  const path = fileWith(TRUNCATED)
  const loaded = loadSettings(path)
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dusk" })
  expect(loaded.problem).toBe("settings.json repaired")
  expect(loaded.backup).toBe(`${path}.bak`)
  expect(readFileSync(`${path}.bak`, "utf8")).toBe(TRUNCATED)
  expect(parseJson(readFileSync(path, "utf8"))).toEqual({ ok: true, value: { theme: "dusk", sidebar: "auto" } })
})

test("a file with comments and trailing commas is read and replaced", () => {
  const loaded = loadSettings(fileWith('{\n  // mine\n  "sidebar": "hidden",\n  "editor": "zed",\n}'))
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, sidebar: "hidden", editor: "zed" })
  expect(loaded.problem).toBe("settings.json repaired")
})

test("a byte order mark is ignored and the protocol's default mode reads as manual", () => {
  const loaded = loadSettings(fileWith('﻿{"permissionMode":"default"}'))
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, permissionMode: "manual" })
  expect(loaded.problem).toBeNull()
})

test("a bad field is reset, the other fields are kept and the file is not archived", () => {
  const path = fileWith('{"theme":"no-such-theme","sidebar":"hidden","notifications":"waiting","extra":1}')
  const loaded = loadSettings(path)
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, sidebar: "hidden", notifications: "waiting" })
  expect(loaded.problem).toBe("settings.json: invalid theme, using the default")
  expect(loaded.backup).toBeNull()
  expect(existsSync(`${path}.bak`)).toBe(false)
})

test("a file that cannot be read is reported and never saved over", () => {
  const path = fileWith(null)
  mkdirSync(path)
  expect(loadSettings(path)).toEqual({ settings: DEFAULT_SETTINGS, problem: UNREADABLE_PROBLEM, backup: null })
  expect(saveSettings({ theme: "dusk" }, path)).toBe(false)
  expect(statSync(path).isDirectory()).toBe(true)
})

test("a second repair keeps the first backup", () => {
  const path = fileWith(TRUNCATED)
  loadSettings(path)
  writeFileSync(path, '{"sidebar": "hidden",')
  loadSettings(path)
  expect(readFileSync(`${path}.bak`, "utf8")).toBe(TRUNCATED)
})
