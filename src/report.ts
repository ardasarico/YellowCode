import type { TerminalCapabilities } from "@opentui/core"
import { buildCommit } from "./build-info.ts"
import { readFileSync } from "node:fs"
import { cpus, homedir, release, totalmem, type, userInfo } from "node:os"
import { basename, join } from "node:path"
import packageJson from "../package.json"
import { apiVersion } from "./mods/version.ts"
import { logFile } from "./log/log.ts"
import type { Detection } from "./agent/agent.ts"
import type { AgentKindId } from "./agent/ids.ts"
import type { ModeRow } from "./agent/lists.ts"
import { modeLabel } from "./session/settings.ts"
import { startModeIn, type StoredSettings } from "./session/settings-file.ts"

// A label and its value; a row without a value is left out of the report.
export type Row = [string, string | null | undefined]

export type ReportFacts = {
  environment: Row[]
  settings: Row[]
  session?: Row[]
  extensions?: Row[]
  log: string[][]
}

const run = (command: string[], cwd?: string) => {
  try {
    const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "ignore", timeout: 2000 })
    return result.exitCode === 0 ? result.stdout.toString().trim() || null : null
  } catch {
    return null
  }
}

const readLine = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim() || null
  } catch {
    return null
  }
}

const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ") || null

function osName(): string {
  if (process.platform === "darwin") return `macOS ${run(["sw_vers", "-productVersion"]) ?? release()}`
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readLine("/etc/os-release") ?? "")?.[1]
  return pretty ?? `${type()} ${release()}`
}

function device(): string | null {
  const model =
    process.platform === "darwin"
      ? run(["sysctl", "-n", "hw.model"])
      : readLine("/sys/devices/virtual/dmi/id/product_name")
  return joined(model, cpus()[0]?.model, `${Math.round(totalmem() / 2 ** 30)} GB`)
}

// An agent's version; null when it is not installed.
export type AgentVersion = { name: string; version: string | null }

// What the machine, Bun and this checkout say, the same in a shell and in the app.
export function hostFacts(agents: AgentVersion[]): Row[] {
  const commit = buildCommit ?? run(["git", "rev-parse", "--short", "HEAD"], join(import.meta.dir, ".."))
  const shell = process.env["SHELL"] ? basename(process.env["SHELL"]) : null
  const locale = process.env["LC_ALL"] || process.env["LC_CTYPE"] || process.env["LANG"]
  return [
    ["YellowCode", joined(packageJson.version, commit)],
    ["Mod API", apiVersion],
    ...agents.map(({ name, version }): Row => [name, version ?? "not found"]),
    ["Bun", Bun.version],
    ["OS", joined(osName(), process.arch)],
    ["Device", device()],
    ["Shell", joined(shell, locale)],
  ]
}

export function agentVersions(agents: { name: string; detect: () => Promise<Detection> }[]): Promise<AgentVersion[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const found = await agent.detect().catch((): Detection => ({ installed: false }))
      return { name: agent.name, version: found.installed ? found.version : null }
    }),
  )
}

// The terminal as the environment names it; the running app also knows what it answered to its queries.
export function terminalFacts(capabilities: TerminalCapabilities | null): Row[] {
  const name = capabilities?.terminal.name || process.env["TERM_PROGRAM"]
  const version = capabilities?.terminal.version || process.env["TERM_PROGRAM_VERSION"]
  // `--report | pbcopy` leaves stdout no terminal; stderr still is one.
  const tty = process.stdout.columns ? process.stdout : process.stderr
  const size = tty.columns ? `${tty.columns}×${tty.rows}` : null
  const rows: Row[] = [
    ["Terminal", joined([name, version].filter(Boolean).join(" ") || null, process.env["TERM"], size)],
  ]
  if (capabilities)
    rows.push(["Graphics", capabilities.kitty_graphics ? "kitty" : "none"], ["Multiplexer", capabilities.multiplexer])
  return rows
}

// The running agent; `modes` give its saved mode's label.
export type ReportAgent = { id: AgentKindId; name: string; modes: ModeRow[] }

// `names` name the agents a saved entry may belong to; an unknown one goes under its id.
export function settingsFacts(
  settings: StoredSettings,
  running: ReportAgent,
  names: { id: AgentKindId; name: string }[],
  problem: string | null,
): Row[] {
  const named = (id: string | undefined) => names.find((agent) => agent.id === id)?.name ?? id
  const others = Object.keys(settings.agents).filter((id) => id !== running.id)
  const mode = startModeIn(settings, running.id)
  return [
    ["Theme", settings.theme],
    ["Sidebar", settings.sidebar],
    ["Thinking", settings.thinking],
    ["Session title", settings.sessionTitle],
    ["Default agent", named(settings.defaultAgent)],
    [`${running.name} mode`, mode === null ? null : modeLabel(running.modes, mode)],
    ...others.map((id): Row => [`${named(id)} mode`, settings.agents[id]?.defaultMode]),
    ["Editor", settings.editor],
    ["Notifications", settings.notifications],
    ["Problem", problem],
  ]
}

// The last `count` entries; an entry starts at its timestamp and may go on over several lines.
export function logTail(count: number): string[][] {
  let text: string
  try {
    text = readFileSync(logFile, "utf8").trimEnd()
  } catch {
    return []
  }
  const entries: string[][] = []
  for (const line of text.split("\n")) {
    const last = entries.at(-1)
    if (last && !/^\d{4}-\d{2}-\d{2}T/.test(line)) last.push(line)
    else entries.push([line])
  }
  return entries.slice(-count)
}

// The home folder and the user name do not go into a report someone pastes in public.
export function scrub(text: string, home = homedir(), user = userName()): string {
  const hidden = text.replaceAll(home, "~")
  if (user.length < 3) return hidden
  return hidden.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "user")
}

function userName(): string {
  try {
    return userInfo().username
  } catch {
    return ""
  }
}

function block(title: string, rows: Row[] | undefined): string[] {
  const shown = (rows ?? []).filter((row): row is [string, string] => Boolean(row[1]))
  if (shown.length === 0) return []
  const width = Math.max(...shown.map(([label]) => label.length)) + 2
  return [`## ${title}`, "", "```text", ...shown.map(([label, value]) => `${label.padEnd(width)}${value}`), "```", ""]
}

export const fileRewindFact = (reason: string | null | undefined) =>
  reason === undefined ? null : reason === null ? "on" : `off (${reason})`

export function reportMarkdown(facts: ReportFacts): string {
  const lines = [
    ...block("Environment", facts.environment),
    ...block("Settings", facts.settings),
    ...block("Session", facts.session),
    ...block("MCP and plugins", facts.extensions),
  ]
  if (facts.log.length > 0)
    lines.push(
      `<details><summary>Log (last ${facts.log.length} entries)</summary>`,
      "",
      "```text",
      ...facts.log.flat(),
      "```",
      "",
      "</details>",
      "",
    )
  return scrub(lines.join("\n"))
}
