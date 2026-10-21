import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostEnv, runClaude } from "./claude-cli.ts"

test("claude's editors run without the marks of a Claude Code session, and with the user's own setup", () => {
  const env = hostEnv({
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "a-session",
    CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/tmp/config",
    PATH: "/usr/bin",
    HOME: "/home/someone",
  })
  expect(env).toEqual({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/tmp/config",
    PATH: "/usr/bin",
    HOME: "/home/someone",
  })
})

test("a claude that ignores SIGTERM is killed, so the run queued behind it still goes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yc-claude-cli-"))
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nif [ "$1" = second ]; then echo ran; exit 0; fi\ntrap '' TERM\nsleep 5\n`,
    { mode: 0o755 },
  )
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
  try {
    const started = performance.now()
    const [stuck, next] = await Promise.all([
      runClaude(["stuck"], { cwd: dir, timeoutMs: 200 }),
      runClaude(["second"], { cwd: dir }),
    ])
    expect(stuck.code).toBeNull()
    expect(next).toMatchObject({ code: 0, stdout: "ran\n" })
    expect(performance.now() - started).toBeLessThan(4500)
  } finally {
    process.env.PATH = path
  }
}, 10_000)
