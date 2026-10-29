import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { scenarios } from "../../tools/record/scenarios.ts"
import {
  BUILTIN_AGENTS,
  bundledNames,
  createNames,
  keptNames,
  learnSkills,
  rewrite,
  SAMPLE_SERVER,
} from "../../tools/record/scrub.ts"
import { parseRecording } from "../source/recording.ts"
import { parseJson } from "../json.ts"
import { parse } from "./parse.ts"

const dir = join(import.meta.dir, "..", "..", "fixtures", "sessions")
const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"))
const transcriptsDir = join(import.meta.dir, "..", "..", "fixtures", "transcripts")
const transcripts = readdirSync(transcriptsDir, { recursive: true, withFileTypes: true }).filter((entry) =>
  entry.isFile(),
)

for (const file of files) {
  test(`${file} parses with no invalid messages`, () => {
    const recording = parseRecording(readFileSync(join(dir, file), "utf8"))
    const invalid = recording.entries.map((entry) => parse(entry.line)).filter((result) => result.kind === "invalid")
    expect(invalid).toEqual([])
  })
}

function expectNoPersonalData(text: string): void {
  expect(text).not.toContain("/var/folders")
  expect(text).not.toMatch(/\/Users\/(?!user\b)/)
  expect(text).not.toMatch(/claude-\d+/)
  const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []
  expect(emails.filter((email) => email !== "user@example.com")).toEqual([])
}

test("recordings contain no personal data", () => {
  for (const file of files) expectNoPersonalData(readFileSync(join(dir, file), "utf8"))
})

// The repo is public: skills, plugins, agents and MCP servers in recordings are built-in, made by the scenario,
// or sample names, never the recording user's own.
test("recordings carry no names from the user's own setup", () => {
  for (const file of files) {
    const recording = parseRecording(readFileSync(join(dir, file), "utf8"))
    const scenario = scenarios.find((entry) => entry.name === recording.header.scenario)
    const names = createNames(keptNames(scenario?.files), bundledNames(dir))
    learnSkills(
      recording.entries.map((entry) => entry.line),
      names,
    )
    for (const { line } of recording.entries) {
      expect(rewrite(line, names)).toBe(line)
      expect(names.unmatched.size).toBe(0)
      const message = parse(line)
      if (message.kind !== "message" || message.message.type !== "system" || message.message.subtype !== "init")
        continue
      for (const server of message.message.mcp_servers) expect(server.name).toMatch(SAMPLE_SERVER)
      for (const plugin of message.message.plugins ?? []) {
        expect(plugin.name).toMatch(/^plugin-[a-z]$/)
        expect(plugin.path).toBe(`/plugins/${plugin.name}`)
        expect(plugin.source ?? "").toMatch(/^plugin-[a-z]@(marketplace-[a-z]|inline|synced|builtin)$/)
      }
    }
  }
})

const SAMPLE_NAME =
  /^(user-skill-\d+|user-agent-\d+|plugin-[a-z]:(skill|command|agent)-\d+|(anthropic-skills:)?synced-skill-\d+)$/

const rowNames = (value: unknown) =>
  z
    .array(z.looseObject({ name: z.string() }))
    .catch([])
    .parse(value)
    .map((row) => row.name)

function listedNames(line: string): string[] {
  const json = parseJson(line)
  if (!json.ok) return []
  const init = z
    .looseObject({
      subtype: z.literal("init"),
      skills: z.array(z.string()).default([]),
      slash_commands: z.array(z.string()).default([]),
      agents: z.array(z.string()).default([]),
    })
    .safeParse(json.value)
  if (init.success) return [...init.data.skills, ...init.data.slash_commands, ...init.data.agents]
  const reply = z
    .looseObject({
      response: z.looseObject({
        response: z.looseObject({ commands: z.unknown(), skills: z.unknown() }),
      }),
    })
    .safeParse(json.value)
  const lists = reply.data?.response.response
  return [...rowNames(lists?.commands), ...rowNames(lists?.skills)]
}

test("recordings list only bundled, scenario and sample skill, command and agent names", () => {
  const bundled = new Set([...bundledNames(dir), ...BUILTIN_AGENTS])
  const scenarioNames = new Set(scenarios.flatMap((scenario) => keptNames(scenario.files)))
  for (const file of files) {
    for (const { line } of parseRecording(readFileSync(join(dir, file), "utf8")).entries) {
      const stray = listedNames(line).filter(
        (name) => !bundled.has(name) && !scenarioNames.has(name) && !SAMPLE_NAME.test(name),
      )
      expect({ file, stray }).toEqual({ file, stray: [] })
    }
  }
})

test("transcripts contain no personal data", () => {
  for (const entry of transcripts) {
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8")
    expectNoPersonalData(text)
    expect(text).not.toContain("/private/tmp")
  }
})
