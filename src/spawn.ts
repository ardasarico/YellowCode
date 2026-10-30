import { collect, GIVE_UP_AFTER_MS, KILL_AFTER_MS, OUTPUT_WAIT_MS } from "./source/claude-cli.ts"

export type Spawned = { code: number | null; stdout: string; stderr: string }

// Null when the command did not end in time and was stopped.
export async function spawnLimited(
  cmd: string[],
  options: { timeoutMs: number; stdin?: string; cwd?: string; env?: Record<string, string> },
): Promise<Spawned | null> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  let late = false
  let kill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    late = true
    proc.kill()
    kill = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS)
  }, options.timeoutMs)
  const stdout = collect(proc.stdout)
  const stderr = collect(proc.stderr)
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(options.timeoutMs + KILL_AFTER_MS + GIVE_UP_AFTER_MS).then(() => null),
  ])
  clearTimeout(timer)
  clearTimeout(kill)
  if (late || code === null) return null
  // A process the command left behind could keep the pipes open; what came until then is kept.
  await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(OUTPUT_WAIT_MS)])
  return { code, stdout: stdout.text, stderr: stderr.text }
}
