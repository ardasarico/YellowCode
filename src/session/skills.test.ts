import { expect, test } from "bun:test"
import type { SettingsSource, SkillRow } from "../protocol/messages.ts"
import { loadRecording, recordedInitLists, recordedSettingsSources, recordedSkillRows } from "../source/recording.ts"
import { skillList } from "./skills.ts"

const row = (name: string, source: string, extra: Partial<SkillRow> = {}): SkillRow => ({
  name,
  display_name: name,
  description: "Does\n  things.",
  source,
  state: "on",
  ...extra,
})

test("groups, labels and filters skill rows", () => {
  const rows = [
    row("mine", "user"),
    row("here", "project", { state: "user-invocable-only" }),
    row("legacy", "project"),
    row("parked", "project", { state: "off" }),
    row("anthropic-skills:synced-skill-1", "claude.ai sync", { display_name: "synced-skill-1" }),
    row("anthropic-skills:synced-skill-2", "claude.ai sync"),
    row("corp", "managed"),
    row("flagged", "flag", { locked_by: "author" }),
    row("claude-api", "bundled"),
    row("uplug:one", "plugin", { locked_by: "plugin" }),
    row("pplug:two", "plugin", { locked_by: "plugin" }),
    row("lplug:three", "plugin", { locked_by: "plugin" }),
    row("synced:four", "plugin", { locked_by: "plugin" }),
  ]
  const init = { skills: ["mine", "here"], slashCommands: ["mine", "here", "legacy"] }
  const sources: SettingsSource[] = [
    { source: "userSettings", settings: { enabledPlugins: { "uplug@market": true, "pplug@market": true } } },
    { source: "projectSettings", settings: { enabledPlugins: { "pplug@market": true, "uplug@market": false } } },
    { source: "localSettings", settings: { enabledPlugins: { lplug: true } } },
  ]

  const skills = skillList(rows, init, sources)
  expect(skills.map((s) => [s.group, s.label, s.plugin, s.command, s.enabled, s.locked])).toEqual([
    ["global", "flagged", null, "flagged", true, true],
    ["global", "four", "synced", "synced:four", true, true],
    ["global", "mine", null, "mine", true, false],
    ["global", "one", "uplug", "uplug:one", true, true],
    ["project", "here", null, "here", true, false],
    ["project", "parked", null, "parked", false, false],
    ["project", "three", "lplug", "lplug:three", true, true],
    ["project", "two", "pplug", "pplug:two", true, true],
    ["claude-ai", "anthropic-skills:synced-skill-2", null, "anthropic-skills:synced-skill-2", true, false],
    ["claude-ai", "corp", null, "corp", true, false],
    ["claude-ai", "synced-skill-1", null, "synced-skill-1", true, false],
  ])
  expect(skills[0]?.description).toBe("Does things.")
})

test("the skills fixture parses whole and groups as recorded", async () => {
  const recording = await loadRecording("fixtures/sessions/skills.jsonl")
  const { rows, problem } = recordedSkillRows(recording)
  expect(problem).toBeNull()

  const skills = skillList(rows, recordedInitLists(recording), recordedSettingsSources(recording))
  const group = (name: string) => skills.find((skill) => skill.name === name)?.group
  expect(skills.some((skill) => skill.name === "hello-cmd")).toBe(false)
  for (const id of ["global", "project", "claude-ai"]) expect(skills.some((skill) => skill.group === id)).toBe(true)
  expect(skills.filter((skill) => skill.plugin === "plugin-b").map((skill) => skill.group)).toEqual([
    "project",
    "project",
    "project",
  ])
  expect(group("plugin-c:skill-1")).toBe("global")
  expect(skills.find((skill) => skill.name === "old-deploy")).toMatchObject({ group: "project", enabled: false })
})
