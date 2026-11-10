import { statSync } from "node:fs"
import { basename } from "node:path"
import { z } from "zod"
import type { McpLaunch } from "../agent/agent.ts"
import type { McpConfig } from "../session/types.ts"
import { printable } from "../ui/format.ts"

export { shownText } from "../ui/format.ts"

const stdioConfig = z.looseObject({ command: z.string(), args: z.array(z.unknown()).optional() })

// The arguments of /bin/sh ahead of the folder and the command line it runs there (mod-tools.ts).
export const IN_FOLDER = ["-c", 'CDPATH= cd -P -- "$1" && shift && exec "$@"', "sh"]

// A server run in its folder through /bin/sh, as the program and arguments it runs.
function unwrapped(config: unknown): unknown {
  const stdio = stdioConfig.safeParse(config).data
  const args = stdio?.args ?? []
  if (stdio?.command !== "/bin/sh" || !IN_FOLDER.every((arg, index) => args[index] === arg)) return config
  const [, command, ...rest] = args.slice(IN_FOLDER.length)
  return typeof command === "string" ? { ...stdio, command, args: rest } : config
}
const remoteConfig = z.looseObject({ url: z.string() })

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

const withProgram = (text: string, command: string) => {
  let shown = text
  const program = programOf(command)
  for (const form of new Set([command, command.trim()]))
    if (form && form !== program) shown = shown.replaceAll(form, program)
  return shown
}

// A port or a count is no secret, nor is a value of under four characters: scrubbing them would turn "the server at
// port 3000" into dots.
const PLAIN_NUMBER = /^\d{1,5}$/

// A value as an error can quote it: as is, trimmed, url-encoded, or escaped inside a JSON string.
const formsOf = (value: string) =>
  value.trim().length < 4 || PLAIN_NUMBER.test(value.trim())
    ? []
    : [value, value.trim(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]

const ALPHANUMERIC = /[\p{L}\p{N}]/u

// Only where the value is not part of a longer word or number.
function valueAt(value: string): RegExp {
  const before = ALPHANUMERIC.test(value.at(0) ?? "") ? "(?<![\\p{L}\\p{N}])" : ""
  const after = ALPHANUMERIC.test(value.at(-1) ?? "") ? "(?![\\p{L}\\p{N}])" : ""
  return new RegExp(`${before}${RegExp.escape(value)}${after}`, "gu")
}

// Text an agent wrote about servers it was given, with nothing of their expanded entries in it: no env or header
// value, no argument, no command string past its program, no url past its origin.
export function withoutServerValues(text: string, servers: readonly McpLaunch[]): string {
  let shown = text
  const values = [
    ...new Set(
      servers.flatMap((server) =>
        ("command" in server ? [...Object.values(server.env), ...server.args] : Object.values(server.headers)).flatMap(
          formsOf,
        ),
      ),
    ),
  ]
    .filter((value) => value.length >= 4)
    .toSorted((a, b) => b.length - a.length)
  for (const value of values) shown = shown.replace(valueAt(value), "…")
  for (const server of servers) if ("command" in server) shown = withProgram(shown, server.command)
  return safeText(shown)
}

// claude's text about a server can quote its url, its command string, or what the server itself sent.
export function safeText(text: string, command?: string): string {
  const shown = command === undefined ? text : withProgram(text, command)
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

export const commandOf = (config: unknown) => stdioConfig.safeParse(unwrapped(config)).data?.command

// Flags that take no value, so the package still comes right after them.
const BARE_FLAGS = new Set(["-y", "--yes", "-q", "--quiet"])
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i

// The package a runner such as npx starts, when it comes first. Anything later (or after a flag that takes a value)
// can be a key, so it is never kept.
function packageOf(command: string, args: unknown[]): string | null {
  const runner = command.split("/").at(-1)
  const rest =
    runner === "npx" || runner === "bunx" || runner === "uvx"
      ? args
      : runner === "pnpm" && args[0] === "dlx"
        ? args.slice(1)
        : null
  const first = rest?.find((arg) => typeof arg !== "string" || !BARE_FLAGS.has(arg))
  return typeof first === "string" && PACKAGE_NAME.test(first) ? first : null
}

// Only what is safe to show: env, headers and other arguments can hold credentials too.
export function configOf(config: unknown): McpConfig | null {
  const stdio = stdioConfig.safeParse(unwrapped(config))
  if (stdio.success) {
    const command = programOf(stdio.data.command)
    return { command: printable(command), package: packageOf(command, stdio.data.args ?? []) }
  }
  const remote = remoteConfig.safeParse(config)
  const url = remote.success ? URL.parse(remote.data.url) : null
  // Without a scheme, user:pass@host parses as scheme "user" with no host.
  return url?.host ? { url: safeUrl(url) } : null
}

// "npx @scope/server", "uvx", "https://host": the program and package, or the url's origin.
export function configText(config: unknown): string {
  const shown = configOf(config)
  if (!shown) return "?"
  return "command" in shown ? [shown.command, shown.package].filter(Boolean).join(" ") : shown.url
}

// What tells two servers apart, none of it shown: the program and package of a command, the origin and path of a url.
export type ServerIdentity = { program: string; package: string | null } | { url: string }

export function identityOf(config: unknown): ServerIdentity | null {
  const stdio = stdioConfig.safeParse(unwrapped(config))
  if (stdio.success) {
    const program = programOf(stdio.data.command)
    const found = packageOf(program, stdio.data.args ?? [])
    // "server@1.2" and "server@latest" are one package.
    return { program: basename(program), package: found && found.replace(/(?<=.)@[^/@]*$/, "") }
  }
  const remote = remoteConfig.safeParse(config)
  const url = remote.success ? URL.parse(remote.data.url) : null
  return url?.host ? { url: `${url.origin}${url.pathname}` } : null
}

// False when they are surely other servers; null when two runs of one program name no package to tell them apart.
export function sameServer(one: ServerIdentity, other: ServerIdentity): boolean | null {
  if ("url" in one || "url" in other) return "url" in one && "url" in other && one.url === other.url
  if (one.program !== other.program) return false
  if (one.package === null && other.package === null) return null
  return one.package === other.package
}
