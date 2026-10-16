import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS, loadSettings } from "./settings-file.ts"

function fileWith(content: string | null): string {
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-settings-")), "settings.json")
  if (content !== null) writeFileSync(path, content)
  return path
}

test("a missing file gives the defaults and no problem", () => {
  expect(loadSettings(fileWith(null))).toEqual({ settings: DEFAULT_SETTINGS, problem: null })
})

test("broken JSON gives the defaults and says so", () => {
  expect(loadSettings(fileWith("{"))).toEqual({
    settings: DEFAULT_SETTINGS,
    problem: "settings.json is not valid JSON, using defaults",
  })
})

test("a byte order mark is ignored and the protocol's default mode reads as manual", () => {
  const loaded = loadSettings(fileWith('﻿{"permissionMode":"default"}'))
  expect(loaded).toEqual({ settings: { ...DEFAULT_SETTINGS, permissionMode: "manual" }, problem: null })
})

test("a bad field is reset and the other fields are kept", () => {
  const loaded = loadSettings(fileWith('{"theme":"neon","sidebar":"hidden","notifications":"waiting","extra":1}'))
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, sidebar: "hidden", notifications: "waiting" })
  expect(loaded.problem).toBe("settings.json: invalid theme, using the default")
})
