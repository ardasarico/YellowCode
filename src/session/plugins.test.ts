import { expect, test } from "bun:test"
import {
  loadRecording,
  recordedInfo,
  recordedPluginHooks,
  recordedSettingsSources,
  recordedSkillRows,
} from "../source/recording.ts"
import { pluginEntries } from "./plugins.ts"

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
