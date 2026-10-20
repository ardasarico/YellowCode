import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"

export type SessionTitle = { title: string; summary: string }

const RECENT_MESSAGES = 12
const Result = z.looseObject({ result: z.string() })

function instructions(messages: readonly string[]): string {
  const recent = messages
    .filter((text) => text.trim() !== "")
    .slice(-RECENT_MESSAGES)
    .map((text) => `- ${text.replace(/\s+/g, " ").slice(0, 300)}`)
  return [
    "These are the latest messages a user sent to a coding assistant.",
    "Answer with exactly two lines in English and nothing else:",
    "TITLE: a name for the work, two or three words",
    "SUMMARY: what is happening now, ten words at most",
    "",
    ...recent,
  ].join("\n")
}

const running = new Set<Bun.Subprocess>()
let stopped = false

export function stopTitles(): void {
  stopped = true
  for (const proc of running) proc.kill()
}

// Asks Haiku through the claude binary, with no tools, customizations or saved session.
export async function titleSession(messages: readonly string[]): Promise<SessionTitle | null> {
  if (stopped) return null
  const proc = Bun.spawn(
    ["claude", "-p", "--model=haiku", "--safe-mode", "--no-session-persistence", "--tools", "", "--output-format=json"],
    { stdin: new Blob([instructions(messages)]), stdout: "pipe", stderr: "pipe" },
  )
  running.add(proc)
  void proc.exited.then(() => running.delete(proc))
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) {
    log.warn("session title failed", { code, stderr: await new Response(proc.stderr).text() })
    return null
  }
  const json = parseJson(output)
  const result = json.ok ? Result.safeParse(json.value) : null
  if (!result?.success) {
    log.warn("session title: unexpected output", output.slice(0, 500))
    return null
  }
  const title = /TITLE:\s*(.+)/i.exec(result.data.result)?.[1]?.trim()
  const summary = /SUMMARY:\s*(.+)/i.exec(result.data.result)?.[1]?.trim()
  return title && summary ? { title, summary } : null
}
