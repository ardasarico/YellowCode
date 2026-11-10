import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skillsAsText, writeSkills } from "./skills.ts"

test("the skills are written as a plugin, and files of an older version go", () => {
  const folder = join(mkdtempSync(join(tmpdir(), "skills-")), "skills")
  mkdirSync(join(folder, "skills", "gone"), { recursive: true })
  writeFileSync(join(folder, "skills", "gone", "SKILL.md"), "old")
  expect(writeSkills(folder)).toBe(folder)
  expect(readFileSync(join(folder, ".claude-plugin", "plugin.json"), "utf8")).toContain('"name": "yellowcode"')
  expect(existsSync(join(folder, "skills", "yellowcode-docs", "usage.md"))).toBe(true)
  expect(existsSync(join(folder, "skills", "yellowcode-mods", "examples", "git", "index.tsx"))).toBe(true)
  expect(existsSync(join(folder, "skills", "gone", "SKILL.md"))).toBe(false)
  expect(skillsAsText([folder])).toContain(`- yellowcode-docs: How YellowCode works`)
})
