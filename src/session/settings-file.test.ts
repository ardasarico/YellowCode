import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJson } from "../json.ts"
import {
  DEFAULT_SETTINGS,
  loadSettings,
  modelKey,
  pickAgent,
  saveSettings,
  UNREADABLE_PROBLEM,
  usedProviders,
} from "./settings-file.ts"

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

test("a truncated file keeps the lists and objects written before the cut", () => {
  const loaded = loadSettings(
    fileWith(
      '{"providers": ["claude", "pi"], "models": {"favorites": ["pi:a/b"], "hidden": []}, ' +
        '"lastModel": {"provider": "pi", "ref": {"provider": "a", "id": "b"}}, "agents": {"claude": {"defau',
    ),
  )
  expect(loaded.settings.providers).toEqual(["claude", "pi"])
  expect(loaded.settings.models).toEqual({ favorites: ["pi:a/b"], hidden: [] })
  expect(loaded.settings.lastModel).toEqual({ provider: "pi", ref: { provider: "a", id: "b" } })
  expect(loaded.problem).toBe("settings.json repaired")
})

test("a file with comments and trailing commas is read and replaced", () => {
  const loaded = loadSettings(fileWith('{\n  // mine\n  "sidebar": "hidden",\n  "editor": "zed",\n}'))
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, sidebar: "hidden", editor: "zed" })
  expect(loaded.problem).toBe("settings.json repaired")
})

test("a byte order mark is ignored and a mode saved as manual reads as claude's default", () => {
  const loaded = loadSettings(fileWith('﻿{"agents":{"claude":{"defaultMode":"manual"}}}'))
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, agents: { claude: { defaultMode: "default" } } })
  expect(loaded.problem).toBeNull()
})

test("a session title saved as claude-code reads as the agent's own", () => {
  expect(loadSettings(fileWith('{"sessionTitle":"claude-code"}')).settings.sessionTitle).toBe("agent")
})

test("the saved mode of a file from before agents had entries becomes Claude's, and saves under it", () => {
  const path = fileWith('{"permissionMode":"plan","theme":"dusk"}')
  const loaded = loadSettings(path)
  expect(loaded.settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dusk", agents: { claude: { defaultMode: "plan" } } })
  saveSettings(loaded.settings, path)
  expect(loadSettings(path).settings).toEqual(loaded.settings)
  expect(readFileSync(path, "utf8")).not.toContain("permissionMode")
})

test("a bad agent entry is reset alone, and another agent's own mode names are kept", () => {
  const loaded = loadSettings(
    fileWith('{"agents":{"claude":{"defaultMode":"plan"},"other":{"defaultMode":"build"},"broken":{"defaultMode":1}}}'),
  )
  expect(loaded.settings.agents).toEqual({ claude: { defaultMode: "plan" }, other: { defaultMode: "build" } })
  expect(loaded.problem).toBe("settings.json: invalid agents.broken, using the default")
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

const KNOWN = ["claude", "opencode", "codex", "pi"]

test("old favorites move to models, the providers used before are found, and the old fields are not saved", () => {
  const path = fileWith(
    JSON.stringify({
      defaultAgent: "codex",
      agents: {
        claude: { defaultMode: "plan", favoriteModels: ["opus"] },
        opencode: { favoriteModels: ["anthropic/claude-opus-5-5"] },
      },
    }),
  )
  const { settings } = loadSettings(path)
  expect(settings.models).toEqual({
    favorites: [
      modelKey("claude", { provider: null, id: "opus" }),
      modelKey("opencode", { provider: "anthropic", id: "claude-opus-5-5" }),
    ],
    hidden: [],
  })
  expect(settings.agents).toEqual({ claude: { defaultMode: "plan" }, opencode: {} })
  expect(usedProviders(settings, KNOWN)).toEqual(["claude", "opencode", "codex"])
  saveSettings(settings, path)
  const text = readFileSync(path, "utf8")
  expect(text).not.toContain("favoriteModels")
  expect(text).not.toContain("defaultAgent")
  expect(loadSettings(path).settings.models).toEqual(settings.models)

  const plain = loadSettings(fileWith('{"theme":"dusk"}')).settings
  expect(plain.models).toEqual({ favorites: [], hidden: [] })
  expect(plain.providers).toBeUndefined()
  expect(usedProviders(plain, KNOWN)).toEqual([])
})

test("a start opens the saved agent when it runs here, else the first installed one", async () => {
  const asked: string[] = []
  const runs = (installed: string[]) => (agent: string) => {
    asked.push(agent)
    return Promise.resolve(installed.includes(agent))
  }
  const agents = ["claude", "opencode", "codex"]
  // Nothing saved: the first installed one, and the last left is not asked.
  expect(await pickAgent(undefined, agents, runs(["opencode"]))).toBe("opencode")
  expect(asked).toEqual(["claude", "opencode"])
  // An agent YellowCode does not know counts as nothing saved.
  expect(await pickAgent("gone", agents, runs(["claude"]))).toBe("claude")
  // A saved agent that is not installed (or cannot run) gives the first installed one.
  asked.length = 0
  expect(await pickAgent("codex", agents, runs(["opencode"]))).toBe("opencode")
  expect(asked).toEqual(["codex", "claude"])
  expect(await pickAgent("opencode", agents, runs(["opencode", "claude"]))).toBe("opencode")
  // With one agent nothing is asked.
  asked.length = 0
  expect(await pickAgent(undefined, ["claude"], runs([]))).toBe("claude")
  expect(asked).toEqual([])
})
