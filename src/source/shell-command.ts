import { blockToken, marked, SHELLS_FOOTER, SHELLS_HEADER } from "../session/handoff.ts"
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
    // Its own process group, so stopping it reaches the commands it started too.
    detached: true,
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
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, name)
    } catch {
      // The whole group has ended.
    }
  }
  return {
    stop() {
      if (stopped) return
      stopped = true
      signal("SIGTERM")
      setTimeout(() => signal("SIGKILL"), KILL_AFTER_MS).unref()
    },
    done: Promise.all([proc.exited, read]).then(([code]) => ({ output, code, stopped })),
  }
}

// The same room Claude Code gives a `!` command's output (protocol/outgoing.ts).
const TOLD_CHARS = 30_000

// A cut at `index` would split a surrogate pair, so it moves past the pair's first half.
function offSurrogate(text: string, index: number): number {
  const code = text.charCodeAt(index - 1)
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index
}

// `!` commands as plain text ahead of the next message, for an agent that takes no shell output of its own. A long
// output keeps its start and its end.
export function shellsText(shells: { command: string; output: string }[]): string {
  const parts = shells.map(({ command, output }) => {
    let kept = output || "(no output)"
    if (output.length > TOLD_CHARS) {
      const start = offSurrogate(output, TOLD_CHARS / 2)
      const end = offSurrogate(output, output.length - TOLD_CHARS / 2)
      kept = `${output.slice(0, start)}\n[${end - start} characters left out]\n${output.slice(end)}`
    }
    return `<command>${command}</command>\n<output>\n${kept}\n</output>`
  })
  const token = blockToken()
  return [marked(SHELLS_HEADER, token), ...parts, marked(SHELLS_FOOTER, token)].join("\n\n")
}
