/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, yellowcode/no-raw-json-parse -- it runs inside pi, whose API has no types here, and imports nothing of ours */
// YellowCode's shared MCP servers for one pi run. YellowCode writes this file out and starts pi with `-e` on it and
// the servers in YELLOWCODE_PI_MCP. `replace`: pi runs with --no-mcp and this extension stands in for pi's own MCP
// extension with none of pi's mcp.json servers. Otherwise pi's own servers run too, and one of a shared server's name
// wins over it, which is reported back.
import * as sdk from "@earendil-works/pi-coding-agent"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const VAR = "YELLOWCODE_PI_MCP"
const HELD = "yellowcode:mcp-held "

const namespace = (name) => name.replace(/-/g, "_")

function namesIn(path) {
  try {
    const servers = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")).mcpServers
    if (typeof servers !== "object" || servers === null) return []
    return Object.entries(servers)
      .filter(([, entry]) => typeof entry === "object" && entry !== null && ("command" in entry || "url" in entry))
      .map(([name]) => name)
  } catch {
    return []
  }
}

function ownNames(ctx) {
  if (typeof sdk.getAgentDir !== "function") return []
  const names = namesIn(join(sdk.getAgentDir(), "mcp.json"))
  const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()
  if (trusted) names.push(...namesIn(join(ctx.cwd, sdk.CONFIG_DIR_NAME ?? ".pi", "mcp.json")))
  return names
}

export default function (pi) {
  const raw = process.env[VAR]
  // Pi's tools and servers inherit its environment, and the list holds the servers' secrets.
  delete process.env[VAR]
  let given = { servers: {}, replace: false }
  try {
    given = JSON.parse(raw ?? "{}")
  } catch {
    // Nothing is registered.
  }
  const names = Object.keys(given.servers ?? {})
  const held = []
  let taken = true
  if (given.replace) {
    if (typeof sdk.createMcpExtension === "function")
      sdk.createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })(pi)
    else taken = false
  }
  for (const name of names) {
    if (!taken || typeof pi.registerMcpServer !== "function") {
      held.push({ name, why: "unsupported" })
      continue
    }
    try {
      pi.registerMcpServer(name, given.servers[name])
    } catch {
      held.push({ name, why: "refused" })
    }
  }
  let told = false
  pi.on("session_start", (_event, ctx) => {
    if (told) return
    told = true
    if (!given.replace) {
      const own = new Set(ownNames(ctx).map(namespace))
      for (const name of names)
        if (own.has(namespace(name)) && !held.some((one) => one.name === name)) held.push({ name, why: "own" })
    }
    if (held.length > 0) ctx.ui.notify(`${HELD}${JSON.stringify(held)}`, "warning")
  })
}
