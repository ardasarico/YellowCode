import { expect, test } from "bun:test"
import { PERMISSION_MODES } from "../session/settings-file.ts"
import { claudeArgs, type Spawn, thinkingArg } from "./claude-args.ts"

test("the saved mode goes out as --permission-mode, and only bypassPermissions brings the allow flag", () => {
  for (const permissionMode of PERMISSION_MODES) {
    const args = claudeArgs({ thinking: "summarized", permissionMode })
    const mode = args[args.indexOf("--permission-mode") + 1]
    expect(mode).toBe(permissionMode === "manual" ? "default" : permissionMode)
    expect(args.includes("--allow-dangerously-skip-permissions")).toBe(permissionMode === "bypassPermissions")
  }
})

test("a new session gets its id, a resume only the id it continues, a fork both", () => {
  const stored = { thinking: "summarized", permissionMode: "auto" } as const
  // They come before the appended prompt, whose line breaks would push them off claude's first line in `ps`.
  const added = (spawn: Spawn) => {
    const args = claudeArgs(stored, spawn)
    return args.slice(args.indexOf(thinkingArg("summarized")) + 1, args.indexOf("--permission-mode"))
  }
  expect(added({})).toEqual([])
  expect(added({ sessionId: "n" })).toEqual(["--session-id", "n"])
  expect(added({ resume: "a" })).toEqual(["--resume", "a"])
  expect(added({ resume: "a", fork: true, sessionId: "n" })).toEqual([
    "--resume",
    "a",
    "--fork-session",
    "--session-id",
    "n",
  ])
})
