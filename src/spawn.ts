import { GIVE_UP_AFTER_MS, KILL_AFTER_MS } from "./source/claude-cli.ts"

export type Spawned = { code: number | null; stdout: string; stderr: string }

// Null when the command did not end in time and was stopped.
export async function spawnLimited(
  cmd: string[],
  options: { timeoutMs: number; stdin?: string; cwd?: string },
): Promise<Spawned | null> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
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
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(options.timeoutMs + KILL_AFTER_MS + GIVE_UP_AFTER_MS).then(() => null),
  ])
  clearTimeout(timer)
  clearTimeout(kill)
  if (late || code === null) return null
  const [stdout, stderr] = await output
  return { code, stdout, stderr }
}
