import { expect, test } from "bun:test"
import { isClaude, sessionsIn } from "./held.ts"

const A = "11111111-2222-4333-8444-555555555555"
const N = "66666666-7777-4888-9999-000000000000"

test("only the flags claude starts a session with name the session a process holds", () => {
  for (const args of [
    `claude --resume ${A}`,
    `claude -r ${A}`,
    `claude --resume=${A}`,
    `claude -r${A}`,
    `/usr/local/bin/claude -p --input-format=stream-json --session-id ${A} --permission-mode default`,
    `claude --session-id=${A}`,
  ])
    expect(sessionsIn(args)).toContain(A)
  for (const args of [`tail -f /Users/user/.claude/projects/x/${A}.jsonl`, `grep -r ${A}.jsonl .`, `vim ${A}.jsonl`])
    expect(sessionsIn(args)).not.toContain(A)
  // A copy holds its own new id, not the session it was copied from.
  expect(sessionsIn(`claude -p --resume ${A} --fork-session --session-id ${N}`)).toEqual([N])
})

test("only a claude process can hold a session", () => {
  for (const args of [
    "claude --resume x",
    "/Users/u/.local/bin/claude -p",
    "node /opt/claude -r x",
    "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -r x",
    "/home/u/.local/share/claude/versions/2.1.3 -p",
  ])
    expect(isClaude(args)).toBe(true)
  for (const args of ["grep -r x .", "/bin/zsh -c claude --resume x", "vim claude.md"])
    expect(isClaude(args)).toBe(false)
})
