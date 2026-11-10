import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { untrustedFolder } from "./trust.ts"

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yc-pi-trust-")))
  const home = join(root, "home")
  const agent = join(root, "agent")
  const project = join(home, "code", "project")
  mkdirSync(project, { recursive: true })
  mkdirSync(agent)
  const env = { HOME: home, PI_CODING_AGENT_DIR: agent }
  return { home, agent, project, env }
}

function write(path: string, text = "x") {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

test("a project with its own skills or .pi files, and no decision, is untrusted", () => {
  const { home, agent, project, env } = setup()
  expect(untrustedFolder(project, env)).toBeNull()
  write(join(home, ".agents", "skills", "mine", "SKILL.md"))
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true })
  mkdirSync(join(project, ".agents", "skills"), { recursive: true })
  expect(untrustedFolder(project, env)).toBeNull()
  write(join(home, "code", ".agents", "skills", "parent", "SKILL.md"))
  expect(untrustedFolder(project, env)).toBe(project)
  write(join(agent, "trust.json"), "not json")
  expect(untrustedFolder(project, env)).toBe(project)
})

test("a saved decision on the folder or a parent, or one for every project, says nothing", () => {
  const { home, agent, project, env } = setup()
  write(join(project, ".pi", "settings.json"), "{}")
  const trust = (saved: Record<string, boolean | null>) => write(join(agent, "trust.json"), JSON.stringify(saved))
  trust({ [project]: null })
  expect(untrustedFolder(project, env)).toBe(project)
  trust({ [home]: true })
  expect(untrustedFolder(project, env)).toBeNull()
  trust({ [project]: false })
  expect(untrustedFolder(project, env)).toBeNull()
  trust({})
  write(join(project, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }))
  expect(untrustedFolder(project, env)).toBe(project)
  write(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }))
  expect(untrustedFolder(project, env)).toBeNull()
})
