import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SkillRow } from "../agent/lists.ts"
import { feed } from "../agents/claude/translate.ts"
import { userMessage } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { createSession } from "./session.ts"
import { skillUses } from "./skills.ts"

const skill = (name: string): SkillRow => ({
  id: name,
  name,
  label: name,
  description: "",
  command: name,
  group: "global",
  plugin: null,
  enabled: true,
  locked: false,
})

test("counts Claude's Skill calls and typed commands", () => {
  const session = createSession()
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", "skill-call.jsonl")
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
  feed(session, "out", parse(userMessage("/user-skill-1 again", [])), 0)
  const skills = [skill("user-skill-1"), skill("other")]
  expect([...skillUses(session.state, skills)]).toEqual([["user-skill-1", 2]])
})
