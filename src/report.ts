import type { TerminalCapabilities } from "@opentui/core"
import { readFileSync } from "node:fs"
import { cpus, homedir, release, totalmem, type, userInfo } from "node:os"
import { basename, join } from "node:path"
import packageJson from "../package.json"
import { logFile } from "./log/log.ts"
import type { StoredSettings } from "./session/settings-file.ts"

// A label and its value; a row without a value is left out of the report.
export type Row = [string, string | null | undefined]

export type ReportFacts = {
  environment: Row[]
  settings: Row[]
  session?: Row[]
  extensions?: Row[]
  log: string[]
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

// What the machine, Bun and this checkout say, the same in a shell and in the app.
export function hostFacts(claudeVersion: string | null): Row[] {
  const commit = run(["git", "rev-parse", "--short", "HEAD"], join(import.meta.dir, ".."))
  const shell = process.env["SHELL"] ? basename(process.env["SHELL"]) : null
  const locale = process.env["LC_ALL"] || process.env["LC_CTYPE"] || process.env["LANG"]
  return [
    ["YellowCode", joined(packageJson.version, commit)],
    ["Claude Code", claudeVersion],
    ["Bun", Bun.version],
    ["OS", joined(osName(), process.arch)],
    ["Device", device()],
    ["Shell", joined(shell, locale)],
  ]
}

// The terminal as the environment names it; the running app also knows what it answered to its queries.
export function terminalFacts(capabilities: TerminalCapabilities | null): Row[] {
  const name = capabilities?.terminal.name || process.env["TERM_PROGRAM"]
  const version = capabilities?.terminal.version || process.env["TERM_PROGRAM_VERSION"]
  const size = process.stdout.columns ? `${process.stdout.columns}×${process.stdout.rows}` : null
  const rows: Row[] = [
    ["Terminal", joined([name, version].filter(Boolean).join(" ") || null, process.env["TERM"], size)],
  ]
  if (capabilities)
    rows.push(["Graphics", capabilities.kitty_graphics ? "kitty" : "none"], ["Multiplexer", capabilities.multiplexer])
  return rows
}

export function settingsFacts(settings: StoredSettings, problem: string | null): Row[] {
  return [
    ["Theme", settings.theme],
    ["Sidebar", settings.sidebar],
    ["Thinking", settings.thinking],
    ["Session title", settings.sessionTitle],
    ["Permission mode", settings.permissionMode],
    ["Editor", settings.editor],
    ["Notifications", settings.notifications],
    ["Problem", problem],
  ]
}

export function logTail(count: number): string[] {
  try {
    return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-count)
  } catch {
    return []
  }
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

export function reportMarkdown(facts: ReportFacts): string {
  const lines = [
    ...block("Environment", facts.environment),
    ...block("Settings", facts.settings),
    ...block("Session", facts.session),
    ...block("MCP and plugins", facts.extensions),
  ]
  if (facts.log.length > 0)
    lines.push(
      `<details><summary>Log (last ${facts.log.length} lines)</summary>`,
      "",
      "```text",
      ...facts.log,
      "```",
      "",
      "</details>",
      "",
    )
  return scrub(lines.join("\n"))
}
