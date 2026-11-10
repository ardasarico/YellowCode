import { type Accessor, createSignal } from "solid-js"
import type { McpLaunch, OwnMcp } from "../agent/agent.ts"
import { type Ask, type AskLine, onceOption } from "../agent/ask.ts"
import { shownText } from "../ui/format.ts"
import { EMPTY_CWD, type McpEntry, type McpFile, type McpScope, nameRule, type SharedServer } from "./servers.ts"
import { type HeldServer, type SharedList, sessionServers, type TrustState } from "./trust.ts"

// What a session has of the shared list, for the /mcp view: the servers handed to the agent, those that were not, with
// why (`waiting`: for the user's answer about the project's file), and the names of the agent's own servers a shared one
// replaced.
export type SharedSession = {
  servers: { name: string; scope: McpScope }[]
  held: (HeldServer & { waiting?: boolean })[]
  replaced: string[]
}

export type Handover = {
  launches: McpLaunch[]
  own: OwnMcp
  session: SharedSession
}

const WAITING: Record<Exclude<TrustState, "trusted">, string> = {
  new: "waiting for your yes",
  changed: "changed · waiting for your yes",
  refused: "off · you said no",
}

export function launchOf({ name, entry }: SharedServer): McpLaunch {
  if ("command" in entry)
    return {
      name,
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ?? {},
      ...(entry.cwd !== undefined && { cwd: entry.cwd }),
    }
  return { name, url: entry.url, headers: entry.headers ?? {}, type: entry.type }
}

// The servers a session starts with, and what it does with the agent's own. `ownOn` is the user's setting.
export function handover(shared: SharedList, ownOn: boolean, env: NodeJS.ProcessEnv = process.env): Handover {
  const { servers, held } = sessionServers(shared, env)
  const { project, trust } = shared
  const waiting =
    project && trust !== null && trust !== "trusted"
      ? Object.keys(project.servers).map((name) => ({
          name,
          scope: "project" as const,
          problem: WAITING[trust],
          waiting: true,
        }))
      : []
  // Claude Code would run these by itself, so they are off there too, and the view says why.
  const rejected = (project?.names ?? [])
    .filter((name) => !(name in (project?.servers ?? {})))
    .map((name) => ({
      name: shownText(name),
      scope: "project" as const,
      problem: `off · ${nameRule(name) ?? (project?.problems.some((found) => found.endsWith(`: ${name}: ${EMPTY_CWD}`)) ? EMPTY_CWD : ENTRY_RULE)}`,
    }))
  return {
    launches: servers.map(launchOf),
    own: ownOf(ownOn, shared.ancestors),
    session: {
      servers: servers.map(({ name, scope }) => ({ name, scope })),
      held: [...held, ...waiting, ...rejected],
      replaced: [],
    },
  }
}

// Linux takes at most 128 KB in one argument, and claude gets these names in one.
const MAX_NAMES_CHARS = 32 * 1024

export const UNREAD_NOTICE =
  "A .mcp.json here could not be read, so Claude Code's own MCP servers are off in this session."
export const TOO_MANY_NOTICE =
  "The .mcp.json files here name too many servers, so Claude Code's own MCP servers are off in this session."

function ownOf(on: boolean, names: string[] | null): OwnMcp {
  if (names === null) return { on, project: [], unsure: UNREAD_NOTICE }
  if (JSON.stringify(names).length > MAX_NAMES_CHARS) return { on, project: [], unsure: TOO_MANY_NOTICE }
  return { on, project: names }
}

const ENTRY_RULE = 'an entry takes command, args, env and cwd, or type "http" or "sse" with url and headers'

export const NEXT_SESSION = "starts with the next session"

// A live session's shared list: the handover it was last given, and what became of it. `hold` takes in a server its
// agent could not run, `replace` one of the agent's own that a shared server stands in for.
export type SharedMcp = {
  handover: Handover
  session: Accessor<SharedSession>
  hold: (name: string, problem: string) => void
  replace: (name: string) => void
  set: (next: Handover) => void
  // The project's servers the user said yes to, which this session cannot start.
  later: () => void
}

export function createSharedMcp(first: Handover): SharedMcp {
  const [session, setSession] = createSignal(first.session)
  const mcp: SharedMcp = {
    handover: first,
    session,
    hold(name, problem) {
      setSession((now) => {
        // A mod's server goes out beside the shared ones; /mods tells of its problems.
        const scope = now.servers.find((server) => server.name === name)?.scope
        if (!scope) return now
        return {
          servers: now.servers.filter((server) => server.name !== name),
          held: [...now.held.filter((server) => server.name !== name), { name, scope, problem }],
          replaced: now.replaced.filter((own) => own !== name),
        }
      })
    },
    replace(name) {
      setSession((now) =>
        now.replaced.includes(name) || !now.servers.some((server) => server.name === name)
          ? now
          : { ...now, replaced: [...now.replaced, name] },
      )
    },
    set(next) {
      mcp.handover = next
      setSession(next.session)
    },
    later() {
      setSession((now) => ({
        ...now,
        held: now.held.map(({ name, scope, problem, waiting }) => ({
          name,
          scope,
          problem: waiting ? NEXT_SESSION : problem,
          waiting,
        })),
      }))
    },
  }
  return mcp
}

// What a provider that takes no MCP servers gets: none of them, and the agent's own as they are.
export const withoutServers = (given: Handover): Handover => ({
  ...given,
  launches: [],
  session: { servers: [], held: given.session.held, replaced: [] },
})

// The project file to ask about at a start: one with servers that have no yes or no for what it holds now, asked once
// per app run (`asked` holds the fingerprints already asked).
export function toAsk(shared: SharedList, asked: ReadonlySet<string>): McpFile | null {
  const { project, trust } = shared
  if (!project || (trust !== "new" && trust !== "changed")) return null
  if (Object.keys(project.servers).length === 0 || asked.has(askKey(project))) return null
  return project
}

export const askKey = (file: McpFile) => `${file.path}\n${file.fingerprint}`

const PREFIX = "mcp-trust-"

export type TrustLine = AskLine

const COMMAND_CHARS = 200
// Variables that change what a program loads, or where it finds the programs it starts.
const LOADERS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "BASH_ENV",
  "ENV",
])
const loads = (name: string) => LOADERS.has(name) || name.startsWith("LD_") || name.startsWith("DYLD_")
const REFERENCES = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g

const readsOf = (texts: string[]) => [
  ...new Set(texts.flatMap((text) => [...text.matchAll(REFERENCES)].map((match) => `$${match[1]}`))),
]

const listed = (names: string[]) => names.map(shownText).join(", ")

function cutText(text: string): string {
  if (text.length <= COMMAND_CHARS) return text
  const kept = text.slice(0, COMMAND_CHARS).replace(/[\ud800-\udbff]$/, "")
  return `${kept}… (${text.length - kept.length} more characters in .mcp.json)`
}

const word = (text: string) => (text === "" || /\s/.test(text) ? JSON.stringify(text) : text)

// The host a url names before its variables are filled in, as a url parser reads it; null when a variable stands in it.
function hostOf(url: string): string | null {
  const authority = /^[a-z][\w+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? url.split(/[/?#]/)[0] ?? ""
  if (authority.includes("${")) return null
  return URL.parse(url.replace(REFERENCES, "x"))?.hostname || authority.split("@").at(-1) || null
}

const detail = (text: string, warn = false) => ({ text: `  ${shownText(text)}`, warn })

type Flag = "loads" | "sends" | "unknown"
const FLAG_ORDER: Flag[] = ["loads", "sends", "unknown"]
// For one server, and for more.
const FLAGS: Record<Flag, [string, string]> = {
  loads: ["changes what programs load", "change what programs load"],
  sends: ["sends your variables to a host", "send your variables to a host"],
  unknown: ["connects to a host set by a variable", "connect to a host set by a variable"],
}

// What decides what a server runs and where its secrets go, as the file has it: never an expanded value.
function serverLines(entry: McpEntry): { lines: TrustLine[]; flags: Flag[] } {
  if ("command" in entry) {
    const args = entry.args ?? []
    const env = Object.keys(entry.env ?? {})
    const reads = readsOf([entry.command, ...args, ...Object.values(entry.env ?? {}), entry.cwd ?? ""])
    const loaders = env.filter(loads)
    return {
      lines: [
        ...(loaders.length > 0 ? [detail(`⚠ ${listed(loaders)} can change what programs it loads`, true)] : []),
        detail(`runs ${cutText([entry.command, ...args].map(word).join(" "))}`),
        ...(entry.cwd === undefined ? [] : [detail(`in folder ${cutText(entry.cwd)}`)]),
        ...(env.length > 0 ? [detail(`sets ${listed(env)}`)] : []),
        ...(reads.length > 0 ? [detail(`reads ${listed(reads)} from your environment`)] : []),
      ],
      flags: loaders.length > 0 ? ["loads"] : [],
    }
  }
  const headers = Object.keys(entry.headers ?? {})
  const sent = readsOf([entry.url, ...Object.values(entry.headers ?? {})])
  const host = hostOf(entry.url)
  const flags: Flag[] = [...(host === null ? ["unknown" as const] : []), ...(sent.length > 0 ? ["sends" as const] : [])]
  return {
    lines: [
      // Ahead of the url, whose cut could hide the host it really names.
      host === null ? detail("⚠ host not known until it runs", true) : detail(`host ${host}`),
      detail(`connects to ${cutText(entry.url)}`),
      ...(headers.length > 0 ? [detail(`headers ${listed(headers)}`)] : []),
      ...(sent.length > 0 ? [detail(`⚠ sends ${listed(sent)} to ${host ?? "that host"}`, true)] : []),
    ],
    flags,
  }
}

// The servers with a warning first.
function ordered(file: McpFile) {
  const all = Object.entries(file.servers).map(([name, entry]) => Object.assign(serverLines(entry), { name }))
  return [...all.filter((server) => server.flags.length > 0), ...all.filter((server) => server.flags.length === 0)]
}

// Each server's name on a row of its own with what it runs beneath, and a blank row between servers. `group` numbers
// the servers in that order.
export function trustLines(file: McpFile): TrustLine[] {
  const rows: TrustLine[] = []
  for (const [group, { name, lines }] of ordered(file).entries()) {
    if (group > 0) rows.push({ text: "", warn: false, group })
    rows.push({ text: shownText(name), warn: false, group })
    for (const line of lines) rows.push(Object.assign(line, { group }))
  }
  return rows
}

// "3 servers · 1 changes what programs load": always when something is warned of, else only when the list is cut.
function summaryLine(file: McpFile): TrustLine {
  const all = ordered(file)
  const counts = FLAG_ORDER.flatMap((flag) => {
    const count = all.filter((server) => server.flags.includes(flag)).length
    return count > 0 ? [`${count} ${FLAGS[flag][count === 1 ? 0 : 1]}`] : []
  })
  const text = [`${all.length} ${all.length === 1 ? "server" : "servers"}`, ...counts].join(" · ")
  return counts.length > 0 ? { text, warn: true } : { text, warn: false, whenCut: true }
}

// Esc closes it unanswered, so it is asked again at the next app start.
export function trustAsk(id: string, file: McpFile): Ask {
  const count = Object.keys(file.servers).length
  const lines = [
    summaryLine(file),
    { text: `.mcp.json adds ${count} ${count === 1 ? "server" : "servers"} to every provider:`, warn: false },
    { text: "", warn: false },
    ...trustLines(file),
  ]
  return {
    id: `${PREFIX}${id}`,
    kind: "permission",
    call: null,
    tool: { name: "mcp", kind: "other", mcp: null },
    title: "MCP servers from this project",
    input: null,
    target: lines
      .filter((row) => !row.whenCut)
      .map((row) => row.text)
      .join("\n"),
    preview: { type: "lines", lines },
    writes: [],
    detail: "",
    reason: "",
    options: [onceOption("yes", "allow", "Yes, use them"), { ...onceOption("no", "deny", "No"), lasts: "project" }],
    questions: null,
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: null,
    escCloses: true,
  }
}

export const trustOf = (askId: string): string | null => (askId.startsWith(PREFIX) ? askId.slice(PREFIX.length) : null)
