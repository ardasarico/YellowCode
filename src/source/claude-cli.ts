import { log } from "../log/log.ts"

// `code` is null when claude did not end in time and was stopped.
export type CliResult = { code: number | null; stdout: string; stderr: string }

const CLI_TIMEOUT_MS = 20_000
// A claude that ignores SIGTERM gets SIGKILL this long after it, and one that outlives that too is given up on.
export const KILL_AFTER_MS = 2000
const GIVE_UP_AFTER_MS = 1000
const OUTPUT_WAIT_MS = 1000

// Variables claude puts on the processes it starts (2.1.305) that mark them as children of its session. Its settings
// editors refuse to run under them, and they describe that session rather than the user's setup, which every other
// variable may be (a proxy, Bedrock, no nonessential traffic). claude also sets AI_AGENT and TRACEPARENT there; their
// names are not claude's own, so they are kept.
const SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
])

export function hostEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !SESSION_MARKERS.has(key)) kept[key] = value
  return kept
}

// The editors do not lock their files, so two runs at once could lose a write.
let queue: Promise<unknown> = Promise.resolve()

// One `claude <args>` run in the session's project, with the binary the session runs, after any run before it.
// Settings files change only through claude itself.
export function runClaude(args: string[], options: { cwd: string; stdin?: string; timeoutMs?: number }) {
  const run = queue.then(() => runNow(args, options))
  queue = run.catch(() => {})
  return run
}

function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const read = { text: "", done: Promise.resolve() }
  read.done = (async () => {
    for await (const chunk of stream) read.text += decoder.decode(chunk, { stream: true })
    read.text += decoder.decode()
  })().catch(() => {})
  return read
}

async function runNow(
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<CliResult> {
  const started = performance.now()
  const proc = Bun.spawn(["claude", ...args], {
    cwd: options.cwd,
    env: hostEnv(),
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS
  let late = false
  let kill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    late = true
    proc.kill()
    kill = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS)
  }, timeoutMs)
  const stdout = collect(proc.stdout)
  const stderr = collect(proc.stderr)
  // The next run waits for this one, so it always ends.
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs + KILL_AFTER_MS + GIVE_UP_AFTER_MS).then(() => null),
  ])
  clearTimeout(timer)
  clearTimeout(kill)
  // A process claude left behind could keep the pipes open; what came until then is kept.
  await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(OUTPUT_WAIT_MS)])
  const result = { code: late ? null : code, stdout: stdout.text, stderr: Bun.stripANSI(stderr.text).trim() }
  log.info(`claude ${args.join(" ")}`, { code: result.code, ms: Math.round(performance.now() - started) })
  return result
}
