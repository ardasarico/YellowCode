// One answer from pi for YellowCode's session titles (pi titles nothing itself): a print run on the default model with
// no session, tools, customizations or thinking. The prompt goes in on stdin, where an `@path` stays plain text.
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

export async function answerOnce(prompt: string, cwd: string): Promise<string | null> {
  const done = await spawnLimited(PRINT, { cwd, stdin: prompt, timeoutMs: TITLE_MS }).catch((error: unknown) => {
    log.warn("pi: session title failed", error instanceof Error ? error.message : String(error))
    return null
  })
  if (done?.code === 0) return done.stdout.trim() || null
  if (done) log.warn("pi: session title failed", { code: done.code, stderrChars: done.stderr.length })
  else log.warn("pi: session title failed", "no answer in time")
  return null
}
