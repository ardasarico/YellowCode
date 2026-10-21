import { expect, test } from "bun:test"
import {
  loadRecording,
  recordedInfo,
  recordedPluginHooks,
  recordedSettingsSources,
  recordedSkillRows,
} from "../source/recording.ts"
import { type Plugin, pluginEntries, pluginScope } from "./plugins.ts"

const sample = (name: string, marketplace: string | null): Plugin => ({
  name,
  marketplace,
  scope: "global",
  on: true,
  brings: { skills: [], mcp: [], commands: [], agents: [], hooks: [] },
})

test("a plugin is switched where its deciding setting lives, and nowhere when no setting names it", () => {
  const sources = [
    { source: "userSettings", settings: { enabledPlugins: { "both@m": true, "user@m": true } } },
    { source: "projectSettings", settings: { enabledPlugins: { "both@m": false } } },
    { source: "localSettings", settings: { enabledPlugins: { "both@m": true } } },
    { source: "flagSettings", settings: { enabledPlugins: { "flag@m": true } } },
  ]
  expect(pluginScope(sample("both", "m"), sources)).toBe("local")
  expect(pluginScope(sample("user", "m"), sources)).toBe("user")
  expect(pluginScope(sample("user", "other"), sources)).toBeNull()
  expect(pluginScope(sample("inline-plug", "inline"), sources)).toBeNull()
  expect(pluginScope(sample("flag", "m"), sources)).toBeNull()
})

test("the plugins fixture lists on and off plugins with what each brings", async () => {
  const recording = await loadRecording("fixtures/sessions/plugins.jsonl")
  const info = recordedInfo(recording)
  if (info === null) throw new Error("no init")
  const plugins = pluginEntries(
    info,
    recordedSettingsSources(recording),
    recordedSkillRows(recording).rows,
    recordedPluginHooks(recording),
  )
  const plugin = (name: string) => plugins.find((entry) => entry.name === name)

  expect(plugin("plugin-b")).toMatchObject({
    marketplace: "marketplace-b",
    scope: "project",
    on: true,
    brings: { skills: ["skill-1", "skill-2", "skill-3"], mcp: ["plugin-b"], hooks: ["Stop"] },
  })
  expect(plugin("plugin-a")).toMatchObject({ scope: "global", brings: { commands: ["command-1"] } })
  expect(plugin("plugin-e")?.brings.agents).toEqual(["agent-1"])
  expect(plugin("plugin-f")).toMatchObject({ marketplace: "marketplace-a", scope: "project", on: false })
})
