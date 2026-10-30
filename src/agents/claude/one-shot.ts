import { z } from "zod"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"
import { collect, hostEnv, KILL_AFTER_MS, OUTPUT_WAIT_MS } from "../../source/claude-cli.ts"

const ONE_SHOT_TIMEOUT_MS = 30_000
const Result = z.looseObject({ result: z.string() })

const running = new Set<Bun.Subprocess>()
let stopped = false

export function stopOneShots(): void {
  stopped = true
  for (const proc of running) proc.kill()
}

// Asks Haiku through the claude binary, with no tools, customizations or saved session.
export async function oneShot(prompt: string, cwd: string): Promise<string | null> {
  if (stopped) return null
  const proc = Bun.spawn(
    ["claude", "-p", "--model=haiku", "--safe-mode", "--no-session-persistence", "--tools", "", "--output-format=json"],
    { cwd, env: hostEnv(), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" },
  )
  running.add(proc)
  void proc.exited.then(() => running.delete(proc))
  let late = false
  let kill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    late = true
    proc.kill()
    kill = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS)
  }, ONE_SHOT_TIMEOUT_MS)
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  const code = await proc.exited
  clearTimeout(timer)
  clearTimeout(kill)
  // A process claude left behind could keep the pipes open; what came until then is kept.
  await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(OUTPUT_WAIT_MS)])
  const output = out.text
  const stderr = err.text
  if (late || code !== 0) {
    log.warn("session title failed", { code, late, stderrChars: stderr.length })
    log.debug("session title stderr", stderr)
    return null
  }
  const json = parseJson(output)
  const result = json.ok ? Result.safeParse(json.value) : null
  if (!result?.success) {
    log.warn("session title: unexpected output", { chars: output.length })
    log.debug("session title output", output.slice(0, 500))
    return null
  }
  return result.data.result
}
