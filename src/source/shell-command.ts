import { KILL_AFTER_MS } from "./claude-cli.ts"

// The end of a long output is what the row and Claude get.
const KEEP_CHARS = 200_000

export type ShellRun = {
  stop(): void
  done: Promise<{ output: string; code: number | null; stopped: boolean }>
}

// Runs a `!` command in the user's shell with stderr folded into stdout; it gets no input.
export function runShell(command: string, cwd: string, onOutput: (output: string) => void): ShellRun {
  const shell = process.env.SHELL || "/bin/sh"
  const proc = Bun.spawn([shell, "-c", `exec 2>&1\n${command}`], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  let stopped = false
  let output = ""
  const read = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-KEEP_CHARS)
      onOutput(output)
    }
  })()
  return {
    stop() {
      if (stopped) return
      stopped = true
      proc.kill()
      setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS).unref()
    },
    done: Promise.all([proc.exited, read]).then(([code]) => ({ output, code, stopped })),
  }
}
