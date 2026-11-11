import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { McpState } from "../../../src/agent/lists.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

const SERVER = readFileSync(join(import.meta.dir, "..", "mcp-echo.ts"), "utf8")

// node strips the server's types; bun lives under the real home, which the isolated service must not touch.
function node(): string {
  const found = Bun.which("node")
  if (!found) throw new Error("the lists scenario needs node (23 or later) on PATH")
  return found
}

const echoIs = (a: AgentDriver, state: McpState) =>
  a.until("lists", (event) => event.lists.mcp?.some((row) => row.name === "echo" && row.state === state) ?? false)

// One local MCP server, one skill and one command from the project, each list read on request; the server turned off
// and on again and restarted; a file search; the command run.
export const lists: AgentScenario = {
  name: "lists",
  files: {
    ".opencode/skill/greet/SKILL.md": "---\nname: greet\ndescription: Greets the user by name\n---\nSay hello.\n",
    ".opencode/command/hello.md": "---\ndescription: Says hello to someone\n---\nPAPA say hello to $ARGUMENTS.\n",
  },
  bin: { "mcp-echo.ts": SERVER },
  config: (_mock, root) => ({
    mcp: { servers: { echo: { type: "local", command: [node(), join(root.bin, "mcp-echo.ts")] } } },
  }),
  script: {
    title: "Lists",
    threads: [{ match: "PAPA say hello to the team", steps: [[{ type: "text", text: "Hello, team." }]] }],
  },
  async run(a) {
    await a.start()
    // opencode reads the folder's servers, skills and commands a moment after its first request there.
    await a.pause(2000)
    a.refresh("commands")
    await a.until("lists", (event) => event.lists.commands !== undefined)
    a.refresh("skills")
    await a.until("lists", (event) => event.lists.skills !== undefined)
    a.refresh("mcp")
    await echoIs(a, "connected")
    await a.files("READ")
    const off = await a.toggleMcp("echo", false)
    if (!off.ok) throw new Error(`echo did not turn off: ${off.problem}`)
    await echoIs(a, "off")
    const on = await a.toggleMcp("echo", true)
    if (!on.ok) throw new Error(`echo did not turn on: ${on.problem}`)
    await echoIs(a, "connected")
    const again = await a.reconnectMcp("echo")
    if (!again.ok) throw new Error(`echo did not restart: ${again.problem}`)
    await a.pause(1000)
    const sent = await a.send("/hello the team")
    if (!sent.ok) throw new Error(`the command did not go out: ${sent.problem}`)
    await a.until("turn.end")
    await a.close()
  },
}
