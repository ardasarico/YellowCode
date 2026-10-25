import { EmbeddedTerminalRenderable, type RenderContext } from "@opentui/core"
import { basename } from "node:path"
import { createSignal } from "solid-js"

// Bun.spawn with a terminal leaves the shell on YellowCode's own tty, so job control (ctrl+z, fg) breaks. perl, found on
// macOS and Linux, makes the pty the shell's controlling terminal before it starts.
const TIOCSCTTY = process.platform === "darwin" ? "0x20007461" : "0x540E"
const CONTROLLING_TTY = `use POSIX; POSIX::setsid(); ioctl(STDIN, ${TIOCSCTTY}, 0) or die "controlling tty: $!"; exec @ARGV`

const LOG_LINES = 2000
// Escape sequences and control characters, so the log reads as text.
// oxlint-disable-next-line no-control-regex -- terminal output is made of them
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

// What a line of output reads as: the text after its last carriage return, without escape codes.
export const plainLine = (raw: string) => (raw.split("\r").at(-1) ?? "").replace(ESCAPES, "")

export type Terminal = {
  id: number
  title: string
  cwd: string
  // Made once and kept: the pane mounts it while shown, so hiding the pane keeps the screen.
  view: EmbeddedTerminalRenderable | null
  pty: Bun.Terminal
  // Output that came before the view existed, and a plain-text log of everything for Claude.
  pending: Uint8Array[]
  log: string[]
  partial: string
  kill(): void
}

export function createTerminals(options: {
  shell: () => string
  cwd: string
  size: () => { cols: number; rows: number }
  onEmpty: () => void
}) {
  const [list, setList] = createSignal<Terminal[]>([])
  const [active, setActive] = createSignal<number | null>(null)
  const decoder = new TextDecoder()
  let next = 1

  function record(terminal: Terminal, data: Uint8Array): void {
    const text = terminal.partial + decoder.decode(data, { stream: true })
    const lines = text.split("\n").map(plainLine)
    terminal.partial = text.slice(text.lastIndexOf("\n") + 1)
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

  function add(): Terminal {
    const shell = options.shell()
    const { cols, rows } = options.size()
    const id = next++
    const terminal: Terminal = {
      id,
      title: basename(shell),
      cwd: options.cwd,
      view: null,
      pending: [],
      log: [],
      partial: "",
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
    const child = Bun.spawn(["perl", "-e", CONTROLLING_TTY, shell, "-l"], {
      cwd: options.cwd,
      terminal: terminal.pty,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    })
    terminal.kill = () => {
      // The shell leads its own session, so its group takes the jobs it started with it.
      try {
        process.kill(-child.pid, "SIGHUP")
      } catch {
        // Already gone.
      }
      terminal.pty.close()
    }
    void child.exited.then(() => close(id))
    setList((current) => [...current, terminal])
    setActive(id)
    return terminal
  }

  return {
    list,
    active: () => list().find((terminal) => terminal.id === active()) ?? null,
    add,
    close,
    closeAll: () => {
      for (const terminal of list()) {
        terminal.kill()
        terminal.view?.destroy()
      }
      setList([])
      setActive(null)
    },
    // 1-based, as the tab strip numbers them.
    select(number: number) {
      const terminal = list()[number - 1]
      if (terminal) setActive(terminal.id)
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

export type Terminals = ReturnType<typeof createTerminals>
