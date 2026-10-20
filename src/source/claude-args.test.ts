import { expect, test } from "bun:test"
import { PERMISSION_MODES } from "../session/settings-file.ts"
import { claudeArgs } from "./claude-args.ts"

test("the saved mode goes out as --permission-mode, and only bypassPermissions brings the allow flag", () => {
  for (const permissionMode of PERMISSION_MODES) {
    const args = claudeArgs({ thinking: "summarized", permissionMode })
    const mode = args[args.indexOf("--permission-mode") + 1]
    expect(mode).toBe(permissionMode === "manual" ? "default" : permissionMode)
    expect(args.includes("--allow-dangerously-skip-permissions")).toBe(permissionMode === "bypassPermissions")
  }
})
