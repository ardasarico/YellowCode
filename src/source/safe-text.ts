import { statSync } from "node:fs"
import { basename } from "node:path"
import { z } from "zod"
import { printable } from "../ui/format.ts"

const stdioCommand = z.looseObject({ command: z.string() })

// A url's path, query, hash and user part can all hold a key (hosted servers put one in the path).
export const safeUrl = (url: URL) => (url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin)

const ASSIGNMENT = /^[A-Za-z_]\w*=/

const isFile = (path: string) => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

// A command string can carry variables and arguments ("KEY=… npx -y server --token …"), so only the program shows:
// the whole string when it names a file (a path with a space), else its first word that sets no variable.
export function programOf(command: string): string {
  const whole = command.trim()
  if (/\s/.test(whole) && isFile(whole)) return basename(whole)
  return whole.split(/\s+/).find((word) => !ASSIGNMENT.test(word)) ?? ""
}

// claude's text about a server can quote its url, its command string, or what the server itself sent.
export function safeText(text: string, command?: string): string {
  let shown = text
  const program = command === undefined ? "" : programOf(command)
  for (const form of new Set([command, command?.trim()]))
    if (form && form !== program) shown = shown.replaceAll(form, program)
  return printable(shown).replace(/[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi, (found) => {
    // claude quotes some urls already cut, such as http://host:9[redacted]?key=REDACTED or http://host:9[redacted].
    const bare = found.replace(/\[redacted\]$/i, "")
    const tail = /[).,;:\]]*$/.exec(bare)?.[0] ?? ""
    const url = URL.parse(bare.slice(0, bare.length - tail.length))
    if (url) return `${safeUrl(url)}${tail}`
    const start = /^([a-z][\w+.-]*:\/\/)([^/?#[\s]*)/i.exec(bare)
    return start ? `${start[1]}${start[2]?.split("@").at(-1) ?? ""}${tail}` : "<url>"
  })
}

export const commandOf = (config: unknown) => stdioCommand.safeParse(config).data?.command
