import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { RuleRow } from "../../../src/agent/lists.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

// The rows from a user and a project config, a shell write that lands in the user's opencode.json, and a write of a
// read-only row, which sends nothing.
export const settings: AgentScenario = {
  name: "settings",
  config: {
    websearch: false,
    compaction: { auto: true, keep: { tokens: 8000 } },
    watcher: { ignore: ["dist/**", "build/**"] },
    warming: false,
    mcp: { timeout: { startup: 20000 } },
  },
  files: {
    "opencode.json": JSON.stringify({
      compaction: { buffer: 30000 },
      tool_output: { max_lines: 500 },
      worktree: { directory: "../trees" },
      policies: [{ action: "provider.use", resource: "openai", effect: "deny" }],
    }),
  },
  script: { title: "Settings", threads: [] },
  async run(a) {
    await a.start()
    await a.settings()
    const written = await a.writeSetting("shell", "/bin/sh")
    if (!written.ok) throw new Error(`the shell was not written: ${written.problem}`)
    await a.settings()
    const refused = await a.writeSetting("web-search", "random")
    if (refused.ok) throw new Error("a read-only row was written")
    await a.close()
  },
  async verify(root) {
    const file = await readFile(join(root.config, "opencode", "opencode.json"), "utf8")
    if (!file.includes('"shell": "/bin/sh"')) throw new Error("opencode.json does not hold the shell")
  },
}

// Up to the rule an "always" saved: the rules are asked for, a shell call is allowed always, and the turn ends.
export async function savedRule(a: AgentDriver): Promise<RuleRow> {
  await a.start()
  a.refresh("rules")
  await a.until("lists", (event) => event.lists.rules !== undefined)
  await a.send("NOVEMBER check the tree")
  const { ask } = await a.until("ask.open")
  await a.answer(ask.id, { type: "option", option: "always", note: null })
  const { lists } = await a.until("lists", (event) => event.lists.rules?.some((rule) => rule.removable) === true)
  await a.until("turn.end")
  const rule = lists.rules?.find((one) => one.removable)
  if (!rule) throw new Error("no saved rule")
  return rule
}

// One "always", then the rule is deleted, as /permissions' Delete does. The rule is saved under the folder's project,
// not the session's.
export const rules: AgentScenario = {
  name: "rules",
  lateCommit: true,
  config: { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
  script: {
    title: "Saved rules",
    threads: [
      {
        match: "NOVEMBER",
        steps: [
          [{ type: "tool", name: "shell", input: { command: "git status" } }],
          [{ type: "text", text: "The tree is clean." }],
        ],
      },
    ],
  },
  async run(a) {
    const rule = await savedRule(a)
    await a.removeRule(rule.id)
    await a.until("lists", (event) => event.lists.rules?.every((one) => !one.removable) === true)
    await a.close()
  },
}
