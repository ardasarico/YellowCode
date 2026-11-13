// How the commands that print and exit (update, mod) look. The terminal's own colors are used, so the lines read on
// a light and a dark background; output that is not a terminal gets plain text.
const tty = process.stdout.isTTY && !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb"
const paint = (code: number, off: number) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[${off}m` : text)

export const accent = paint(33, 39)
export const dim = paint(2, 22)
export const bold = paint(1, 22)
const good = paint(32, 39)
const bad = paint(31, 39)

export const say = (line = "") => process.stdout.write(line ? `  ${line}\n` : "\n")
export const done = (line: string) => say(`${good("✓")} ${line}`)
export const warn = (line: string) => say(`${accent("⚠")} ${line}`)
export const problem = (line: string) => process.stderr.write(`  ${bad("✗")} ${line}\n`)
export const title = (rest: string) => say(`${accent("●")} ${bold("YellowCode")}  ${rest}`)

const BAR = 30
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

const draw = (text: string) => {
  if (tty) process.stdout.write(`\r\x1b[2K  ${text}`)
}

// One line that is redrawn in place while something runs, and is gone once it ends.
export function live() {
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    bar: (got: number, total: number) => {
      if (total <= 0) return draw(dim(`${megabytes(got)} MB`))
      const filled = Math.min(BAR, Math.floor((got * BAR) / total))
      draw(
        `${accent("━".repeat(filled))}${dim("━".repeat(BAR - filled))}  ${dim(`${megabytes(got)} / ${megabytes(total)} MB`)}`,
      )
    },
    spin: (text: string) => {
      let frame = 0
      timer = setInterval(() => draw(`${accent(FRAMES[frame++ % FRAMES.length] ?? "")} ${dim(text)}`), 80)
    },
    clear: () => {
      clearInterval(timer)
      if (tty) process.stdout.write("\r\x1b[2K")
    },
  }
}
