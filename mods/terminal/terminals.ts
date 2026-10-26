import { EmbeddedTerminalRenderable, type RenderContext } from "@opentui/core"
import { basename } from "node:path"
import { createSignal } from "solid-js"

// Bun.spawn with a terminal leaves the shell on YellowCode's own tty, so job control (ctrl+z, fg) breaks. perl, found on
// macOS and Linux, makes the pty the shell's controlling terminal before it starts.
const TIOCSCTTY = process.platform === "darwin" ? "0x20007461" : "0x540E"
const CONTROLLING_TTY = `use POSIX; POSIX::setsid(); ioctl(STDIN, ${TIOCSCTTY}, 0) or die "controlling tty: $!"; exec @ARGV or die "cannot run $ARGV[0]: $!"`

// The process groups on the shell's terminal other than the shell's own.
function jobsOn(shell: number): number[] {
  const tty = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(shell)])
    .stdout.toString()
    .trim()
  if (!tty || tty.startsWith("?")) return []
  const groups = Bun.spawnSync(["ps", "-o", "pgid=", "-t", tty]).stdout.toString().split("\n").map(Number)
  return [...new Set(groups)].filter((group) => group > 0 && group !== shell)
}

const LOG_LINES = 2000
// A full-screen program redraws without newlines; past this the unfinished line keeps only its end.
const PARTIAL_LIMIT = 8192
// A shell that ends this soon after it started did not start at all.
const FAILED_START_MS = 2000
// Escape sequences and control characters, so the log reads as text.
// oxlint-disable-next-line no-control-regex -- terminal output is made of them
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

// What a line of output reads as: the text after its last carriage return, without escape codes. A pty ends lines with
// "\r\n", so a carriage return at the end is not one.
export const plainLine = (raw: string) => (raw.replace(/\r+$/, "").split("\r").at(-1) ?? "").replace(ESCAPES, "")

// The window title a program sets with OSC 0 or 2.
// oxlint-disable-next-line no-control-regex -- the sequence is made of control characters
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

export type Terminal = {
  id: number
  // What the shell set as its title, else the command running in it, else the shell's name.
  readonly title: string
  shellName: string
  setTitle(title: string): void
  setCommand(command: string | null): void
  pid: number | null
  cwd: string
  // Made once and kept: the pane mounts it while shown, so hiding the pane keeps the screen.
  view: EmbeddedTerminalRenderable | null
  pty: Bun.Terminal
  // Output that came before the view existed, and a plain-text log of everything for Claude.
  pending: Uint8Array[]
  log: string[]
  partial: string
  // Its own, since a character can be split across two chunks of output.
  decoder: TextDecoder
  kill(): void
}

export function createTerminals(options: {
  shell: () => string
  cwd: string
  size: () => { cols: number; rows: number }
  onEmpty: () => void
  // A shell that could not start, with why.
  onFailed: (message: string) => void
}) {
  const [list, setList] = createSignal<Terminal[]>([])
  const [active, setActive] = createSignal<number | null>(null)
  let next = 1

  function record(terminal: Terminal, data: Uint8Array): void {
    const text = terminal.partial + terminal.decoder.decode(data, { stream: true })
    const titles = [...text.matchAll(TITLE)]
    const title = titles.at(-1)?.[1]
    if (title !== undefined) terminal.setTitle(title.trim())
    const lines = text.split("\n").map(plainLine)
    terminal.partial = text.slice(text.lastIndexOf("\n") + 1).slice(-PARTIAL_LIMIT)
    lines.pop()
    terminal.log.push(...lines)
    if (terminal.log.length > LOG_LINES) terminal.log.splice(0, terminal.log.length - LOG_LINES)
  }

  function close(id: number): void {
    const terminal = list().find((entry) => entry.id === id)
    if (!terminal) return
    terminal.kill()
    terminal.view?.destroy()
    const rest = list().filter((entry) => entry !== terminal)
    setList(rest)
    if (active() === id) setActive(rest.at(-1)?.id ?? null)
    if (rest.length === 0) options.onEmpty()
  }

  function add(): Terminal | null {
    const shell = options.shell()
    const { cols, rows } = options.size()
    const id = next++
    const [title, setTitle] = createSignal("")
    const [command, setCommand] = createSignal<string | null>(null)
    const shellName = basename(shell)
    const terminal: Terminal = {
      id,
      get title() {
        return title() || command() || shellName
      },
      shellName,
      setTitle,
      setCommand,
      pid: null,
      cwd: options.cwd,
      view: null,
      pending: [],
      log: [],
      partial: "",
      decoder: new TextDecoder(),
      pty: new Bun.Terminal({
        cols,
        rows,
        data: (_pty, data) => {
          record(terminal, data)
          if (terminal.view) terminal.view.write(data)
          else terminal.pending.push(data)
        },
      }),
      kill: () => {},
    }
    let child: Bun.Subprocess
    try {
      child = Bun.spawn(["perl", "-e", CONTROLLING_TTY, shell, "-l"], {
        cwd: options.cwd,
        terminal: terminal.pty,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      })
    } catch (error) {
      terminal.pty.close()
      options.onFailed(`cannot start a terminal: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    const started = Date.now()
    // perl execs the shell, so the child's pid is the shell's.
    terminal.pid = child.pid
    terminal.kill = () => {
      // Each background job has its own process group, and bash does not pass the hangup on to them.
      for (const pid of [child.pid, ...jobsOn(child.pid)]) {
        try {
          process.kill(-pid, "SIGHUP")
        } catch {
          // Already gone.
        }
      }
      terminal.pty.close()
    }
    void child.exited.then((code) => {
      const early = code !== 0 && Date.now() - started < FAILED_START_MS
      const why = [...terminal.log, plainLine(terminal.partial)].findLast((line) => line.trim() !== "")
      close(id)
      if (early) options.onFailed(why ?? `${shell} exited with ${code}`)
    })
    setList((current) => [...current, terminal])
    setActive(id)
    return terminal
  }

  // The program in the foreground of each terminal, by its name; the shell itself counts as nothing running.
  async function refreshCommands(): Promise<void> {
    await Promise.all(
      list().map(async (terminal) => {
        if (terminal.pid === null) return
        const group = (await output(["ps", "-o", "tpgid=", "-p", String(terminal.pid)])).trim()
        const name = group && group !== String(terminal.pid) ? await output(["ps", "-o", "comm=", "-p", group]) : ""
        const command = basename(name.trim()).replace(/^-/, "")
        terminal.setCommand(command && command !== terminal.shellName ? command : null)
      }),
    )
  }

  return {
    list,
    refreshCommands,
    active: () => list().find((terminal) => terminal.id === active()) ?? null,
    add,
    closeAll: () => {
      for (const terminal of list()) {
        terminal.kill()
        terminal.view?.destroy()
      }
      setList([])
      setActive(null)
    },
    // 1-based, as the tab strip numbers them.
    select(number: number): boolean {
      const terminal = list()[number - 1]
      if (terminal) setActive(terminal.id)
      return terminal !== undefined
    },
    selectId: (id: number) => setActive(id),
    viewOf(terminal: Terminal, context: RenderContext): EmbeddedTerminalRenderable {
      if (terminal.view) return terminal.view
      const { cols, rows } = options.size()
      const view = new EmbeddedTerminalRenderable(context, {
        cols,
        rows,
        width: cols,
        height: rows,
        // The terminal's own replies to the program's queries; vim waits for them.
        onData: (data, source) => {
          if (source === "response") terminal.pty.write(data)
        },
      })
      terminal.view = view
      for (const data of terminal.pending.splice(0)) view.write(data)
      return view
    },
    resize(cols: number, rows: number) {
      for (const terminal of list()) {
        terminal.pty.resize(cols, rows)
        if (terminal.view) {
          terminal.view.width = cols
          terminal.view.height = rows
        }
      }
    },
  }
}

async function output(command: string[]): Promise<string> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(child.stdout).text()
    await child.exited
    return text
  } catch {
    return ""
  }
}

export type Terminals = ReturnType<typeof createTerminals>
