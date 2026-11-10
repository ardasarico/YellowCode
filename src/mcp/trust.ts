import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { parseJson } from "../json.ts"
import { log } from "../log/log.ts"
import {
  ancestorNames,
  EMPTY_CWD,
  expandEntry,
  findProjectFile,
  globalFile,
  type McpFile,
  type McpScope,
  mergeServers,
  needsProblem,
  readMcpFile,
  type SharedServer,
} from "./servers.ts"

// A project's servers are used only after the user said yes to them. The answer holds for the fingerprint it was
// given to; another fingerprint asks again. The global file is always trusted.
export type TrustState = "trusted" | "changed" | "new" | "refused"

const Answer = z.object({ fingerprint: z.string(), trusted: z.boolean() })
const Answers = z.record(z.string(), Answer)

// Answers by the project file's path, which findProjectFile and newProjectFile give with symlinks resolved.
export const trustFile = () => configPath("mcp-trust.json")

function readAnswers(store: string): Record<string, z.output<typeof Answer>> {
  let text: string
  try {
    text = readFileSync(store, "utf8")
  } catch {
    return {}
  }
  const json = parseJson(text)
  const answers = json.ok ? Answers.safeParse(json.value) : null
  return answers?.success ? answers.data : {}
}

export function trustState(file: McpFile, store = trustFile()): TrustState {
  const answer = readAnswers(store)[file.path]
  if (!answer) return "new"
  if (answer.fingerprint !== file.fingerprint) return "changed"
  return answer.trusted ? "trusted" : "refused"
}

// The user's yes or no to the file's servers as they are now.
export function recordTrust(file: McpFile, trusted: boolean, store = trustFile()): boolean {
  const answers = readAnswers(store)
  answers[file.path] = { fingerprint: file.fingerprint, trusted }
  const temp = `${store}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(store), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(answers, null, 2)}\n`)
    renameSync(temp, store)
    return true
  } catch (error) {
    rmSync(temp, { force: true })
    log.warn("cannot save the MCP trust answer", error)
    return false
  }
}

// `ancestors`: the names of every .mcp.json from the folder up to /, which Claude Code reads by itself; null when one
// of them cannot be read for sure.
export type SharedList = {
  global: McpFile
  project: McpFile | null
  trust: TrustState | null
  ancestors: string[] | null
}

export function loadShared(cwd: string, store = trustFile(), global = globalFile()): SharedList {
  const projectPath = findProjectFile(cwd)
  const project = projectPath === null ? null : readMcpFile(projectPath)
  return {
    global: readMcpFile(global),
    project,
    trust: project && trustState(project, store),
    ancestors: ancestorNames(cwd),
  }
}

export type HeldServer = { name: string; scope: McpScope; problem: string }

// What a session gets: the global servers, and the project's when it is trusted, with their variables expanded.
// The expanded entries hold secrets: keep them in memory only.
export function sessionServers(
  shared: SharedList,
  env: NodeJS.ProcessEnv = process.env,
): { servers: SharedServer[]; held: HeldServer[] } {
  const servers: SharedServer[] = []
  const held: HeldServer[] = []
  for (const server of mergeServers(shared.global, shared.trust === "trusted" ? shared.project : null)) {
    const expanded = expandEntry(server.entry, env)
    if (expanded.ok && "command" in expanded.value && expanded.value.cwd === "")
      held.push({ name: server.name, scope: server.scope, problem: EMPTY_CWD })
    else if (expanded.ok) servers.push({ ...server, entry: expanded.value })
    else held.push({ name: server.name, scope: server.scope, problem: needsProblem(expanded.missing) })
  }
  return { servers, held }
}
