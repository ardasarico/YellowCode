// One answer from pi for YellowCode's session titles (pi titles nothing itself): a print run on the default model with
// no session, tools, customizations or thinking. The prompt goes in on stdin, where an `@path` stays plain text.
import type { OneShotOptions } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { spawnLimited } from "../../spawn.ts"

const TITLE_MS = 30_000
const INSTRUCTIONS = "Answer the user's message exactly as it asks, in plain text."

const PRINT = [
  "pi",
  "--print",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-approve",
  "--thinking",
  "off",
  "--system-prompt",
  INSTRUCTIONS,
]

export async function answerOnce(prompt: string, cwd: string, options: OneShotOptions = {}): Promise<string | null> {
  const { model } = options
  const named = model ? ["--model", model.provider ? `${model.provider}/${model.id}` : model.id] : []
  const run = { cwd, stdin: prompt, timeoutMs: options.timeoutMs ?? TITLE_MS }
  const done = await spawnLimited([...PRINT, ...named], run).catch((error: unknown) => {
    log.warn("pi: one-shot failed", error instanceof Error ? error.message : String(error))
    return null
  })
  if (done?.code === 0) return done.stdout.trim() || null
  if (done) log.warn("pi: one-shot failed", { code: done.code, stderrChars: done.stderr.length })
  else log.warn("pi: one-shot failed", "no answer in time")
  return null
}
