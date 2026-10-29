import { expect, test } from "bun:test"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { claudeArgs, launchOf, type Spawn, thinkingArg } from "./claude-args.ts"

const modeOf = (args: string[]) => args[args.indexOf("--permission-mode") + 1]

test("the saved mode goes out as --permission-mode, and only bypassPermissions brings the allow flag", () => {
  for (const { id: permissionMode } of CLAUDE_MODES) {
    const args = claudeArgs({ thinking: "summarized" }, launchOf({ permissionMode }))
    expect(modeOf(args)).toBe(permissionMode)
    expect(args.includes("--allow-dangerously-skip-permissions")).toBe(permissionMode === "bypassPermissions")
  }
})

test("a restarted session starts in its own mode, and keeps the allow flag the saved bypassPermissions brings", () => {
  const plan = claudeArgs({ thinking: "summarized" }, launchOf({ permissionMode: "auto" }, "plan"))
  expect(modeOf(plan)).toBe("plan")
  expect(plan.includes("--allow-dangerously-skip-permissions")).toBe(false)
  const fromBypass = claudeArgs({ thinking: "summarized" }, launchOf({ permissionMode: "bypassPermissions" }, "plan"))
  expect(modeOf(fromBypass)).toBe("plan")
  expect(fromBypass.includes("--allow-dangerously-skip-permissions")).toBe(true)
})

test("a new session gets its id, a resume only the id it continues, a fork both", () => {
  const launch = launchOf({ permissionMode: "auto" })
  // They come before the appended prompt, whose line breaks would push them off claude's first line in `ps`.
  const added = (spawn: Spawn) => {
    const args = claudeArgs({ thinking: "summarized" }, launch, spawn)
    return args.slice(args.indexOf(thinkingArg("summarized")) + 1, args.indexOf("--permission-mode"))
  }
  expect(added({})).toEqual([])
  expect(added({ sessionId: "n" })).toEqual(["--session-id", "n"])
  expect(added({ resume: "a" })).toEqual(["--resume", "a"])
  expect(added({ resume: "a", at: "u" })).toEqual(["--resume", "a", "--resume-session-at", "u"])
  expect(added({ resume: "a", fork: true, sessionId: "n" })).toEqual([
    "--resume",
    "a",
    "--fork-session",
    "--session-id",
    "n",
  ])
})

test("every spawn allows our own ask and turns the stock one off, each flag in one argument", () => {
  const spawns: Spawn[] = [{}, { resume: "a", at: "u" }, { resume: "a", fork: true, sessionId: "n" }]
  for (const spawn of spawns) {
    const args = claudeArgs({ thinking: "summarized" }, launchOf({ permissionMode: "plan" }), spawn)
    expect(args).toContain("--allowedTools=mcp__yellowcode__ask")
    expect(args).toContain("--disallowedTools=AskUserQuestion")
  }
})
