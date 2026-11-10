import { tildePath } from "../rewind/common.ts"
import { configText } from "../source/safe-text.ts"
import { printable } from "../ui/format.ts"
import {
  findProjectFile,
  globalFile,
  hasReference,
  type McpEntry,
  type McpFile,
  type McpScope,
  nameProblem,
  needsProblem,
  newProjectFile,
  readMcpFile,
  expandEntry,
  writeServer,
} from "./servers.ts"
import { loadShared, recordTrust, trustState, type TrustState } from "./trust.ts"

export const MCP_USAGE = [
  "       yellowcode mcp add <name> [--project] [-e KEY]... -- <command> [args...]",
  "       yellowcode mcp add <name> [--project] --url <url> [--transport http|sse] [-H 'Name: ${VAR}']...",
  "       yellowcode mcp list",
  "       yellowcode mcp remove <name> [--project]",
].join("\n")

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

const say = (line: string) => process.stdout.write(`${line}\n`)

function fail(line: string): number {
  process.stderr.write(`${line}\n`)
  return 1
}

const usage = () => fail(`Usage:\n${MCP_USAGE.replaceAll("       ", "  ")}`)

export function runMcpCommand(args: string[], cwd = process.cwd()): number {
  const [command, ...rest] = args
  if (command === "add") return add(rest, cwd)
  if (command === "list" && rest.length === 0) return list(cwd)
  if (command === "remove") return remove(rest, cwd)
  return usage()
}

export type AddRequest = { name: string; project: boolean; entry: Record<string, unknown> }

// "usage" when the words do not make an add at all.
export function parseAdd(args: string[]): AddRequest | { problem: string } | "usage" {
  const dash = args.indexOf("--")
  const words = dash === -1 ? args : args.slice(0, dash)
  const command = dash === -1 ? [] : args.slice(dash + 1)
  const positionals: string[] = []
  const envs: string[] = []
  const headers: string[] = []
  let project = false
  let url: string | undefined
  let transport: string | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ""
    if (word === "--project") {
      project = true
      continue
    }
    if (!word.startsWith("-") || word === "-") {
      positionals.push(word)
      continue
    }
    const value = words[++i]
    if (value === undefined) return "usage"
    if (word === "-e" || word === "--env") envs.push(value)
    else if (word === "-H" || word === "--header") headers.push(value)
    else if (word === "--url") url = value
    else if (word === "--transport" || word === "-t") transport = value
    else return { problem: `Unknown option ${word}.` }
  }
  const [name, positionalUrl, ...extra] = positionals
  if (name === undefined || extra.length > 0 || (url !== undefined && positionalUrl !== undefined)) return "usage"
  url ??= positionalUrl
  const problem = nameProblem(name)
  if (problem) return { problem: `${problem}.` }

  if (url !== undefined) {
    if (command.length > 0) return { problem: "A server takes a command or a URL, not both." }
    if (envs.length > 0) return { problem: "-e is for a command; a URL server takes -H." }
    const type = transport ?? "http"
    if (type !== "http" && type !== "sse") return { problem: "--transport takes http or sse." }
    const parsed: Record<string, string> = {}
    for (const header of headers) {
      const colon = header.indexOf(":")
      const key = header.slice(0, colon).trim()
      const value = header.slice(colon + 1).trim()
      if (colon === -1 || !HEADER_NAME.test(key)) return { problem: "-H takes 'Name: value'." }
      if (!hasReference(value))
        return {
          problem: `The value of header ${key} would be written into the file; export it and write it as \${VAR}, like -H '${key}: Bearer \${TOKEN}'.`,
        }
      parsed[key] = value
    }
    return { name, project, entry: { type, url, ...(headers.length > 0 && { headers: parsed }) } }
  }

  if (transport !== undefined && transport !== "stdio") return { problem: `--transport ${transport} takes a URL.` }
  if (headers.length > 0) return { problem: "-H is for a URL server; a command takes -e." }
  const [program, ...programArgs] = command
  if (program === undefined || program === "") return "usage"
  const env: Record<string, string> = {}
  for (const item of envs) {
    const equals = item.indexOf("=")
    const key = equals === -1 ? item : item.slice(0, equals)
    if (!ENV_KEY.test(key)) return { problem: `-e takes a variable name such as GITHUB_TOKEN.` }
    const value = equals === -1 ? `\${${key}}` : item.slice(equals + 1)
    if (!hasReference(value))
      return { problem: `The value of ${key} would be written into the file; export it and pass -e ${key} instead.` }
    env[key] = value
  }
  return {
    name,
    project,
    entry: {
      type: "stdio",
      command: program,
      ...(programArgs.length > 0 && { args: programArgs }),
      ...(envs.length > 0 && { env }),
    },
  }
}

function add(args: string[], cwd: string): number {
  const request = parseAdd(args)
  if (request === "usage") return usage()
  if ("problem" in request) return fail(request.problem)
  const path = request.project ? (findProjectFile(cwd) ?? newProjectFile(cwd)) : globalFile()
  const before = readMcpFile(path)
  // A file the user had said yes to, or one this write makes, holds only what they wrote and trusted. Any other may
  // hold servers they were never asked about.
  const trusted = request.project && (!before.found || trustState(before) === "trusted")
  const written = writeServer(path, request.name, request.entry)
  if (!written.ok) return fail(written.problem)
  if (trusted) recordTrust({ ...before, fingerprint: written.fingerprint }, true)
  say(
    `${written.replaced ? "Replaced" : "Added"} ${request.name} ${written.replaced ? "in" : "to"} ${tildePath(path)}.`,
  )
  if (request.project && !trusted) say("YellowCode asks you about this project's .mcp.json before it uses its servers.")
  return 0
}

function remove(args: string[], cwd: string): number {
  const project = args.includes("--project")
  const names = args.filter((arg) => arg !== "--project")
  const [name] = names
  if (name === undefined || names.length > 1 || name.startsWith("-")) return usage()
  const path = project ? findProjectFile(cwd) : globalFile()
  if (path === null) return fail("This project has no .mcp.json.")
  const before = readMcpFile(path)
  if (!before.found || !(name in before.servers)) return fail(`${name} is not in ${tildePath(path)}.`)
  const wasTrusted = project && trustState(before) === "trusted"
  const written = writeServer(path, name, null)
  if (!written.ok) return fail(written.problem)
  if (wasTrusted) recordTrust({ ...before, fingerprint: written.fingerprint }, true)
  say(`Removed ${name} from ${tildePath(path)}.`)
  return 0
}

const TRUST_TEXT: Record<TrustState, string> = {
  trusted: "trusted",
  new: "new, not used until you say yes in YellowCode",
  changed: "changed since you said yes, not used until you say yes again",
  refused: "you said no, not used",
}

const shown = (word: string) => {
  const text = printable(word)
  return /\s/.test(text) || text === "" ? JSON.stringify(text) : text
}

// Never a value from env or headers, nor the arguments or a url's path: they can hold secrets.
function row(name: string, scope: McpScope, entry: McpEntry, replaces: boolean): string {
  const parts = [name, scope, "command" in entry ? "stdio" : entry.type, configText(entry)]
  const names = Object.keys(("command" in entry ? entry.env : entry.headers) ?? {})
  if (names.length > 0) parts.push(`${"command" in entry ? "env" : "headers"} ${names.map(shown).join(", ")}`)
  const expanded = expandEntry(entry, process.env)
  if (!expanded.ok) parts.push(needsProblem(expanded.missing))
  if (replaces) parts.push("replaces the global one")
  return parts.join(" · ")
}

function list(cwd: string): number {
  const { global, project, trust } = loadShared(cwd)
  const files: [McpFile, McpScope][] = project
    ? [
        [global, "global"],
        [project, "project"],
      ]
    : [[global, "global"]]
  const rows = files.flatMap(([file, scope]) =>
    Object.entries(file.servers).map(([name, entry]) =>
      row(name, scope, entry, scope === "project" && name in global.servers),
    ),
  )
  if (rows.length === 0) say("No MCP servers.")
  for (const line of rows) say(line)
  say("")
  say(`Global: ${tildePath(global.path)}${global.found ? "" : " (not there yet)"}`)
  say(project && trust ? `Project: ${tildePath(project.path)} · ${TRUST_TEXT[trust]}` : "Project: no .mcp.json")
  for (const problem of [...global.problems, ...(project?.problems ?? [])]) say(`⚠ ${printable(problem)}`)
  return 0
}
