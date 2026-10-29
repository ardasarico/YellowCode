import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AskReply } from "../../../src/agent/ask.ts"
import type { AgentScenario } from "../scenario.ts"
import { ECHO } from "./tools.ts"
import { turn } from "./turns.ts"

const allow: AskReply = { type: "option", option: "accept", note: null }

// A mod's manifest server, handed to Codex as a config override of the thread: Codex starts it with the thread, the
// model finds its tool, Codex asks before it runs, and a resume in a new app-server starts it again.
export const modServers: AgentScenario = {
  name: "mod-servers",
  files: { ".mcp/echo.ts": ECHO },
  script: {
    threads: [
      {
        match: "YANKEE",
        steps: [
          [{ type: "search", query: "echo" }],
          [{ type: "call", namespace: "mcp__mod_demo__echo", name: "echo", arguments: { text: "from the mod" } }],
          [{ type: "text", text: "The mod's server answered." }],
        ],
      },
      {
        match: "ZULU",
        steps: [[{ type: "text", text: "Still here." }]],
      },
    ],
  },
  async run(a) {
    const launch = { name: "mod-demo--echo", command: "node", args: [join(a.directory, ".mcp", "echo.ts")], env: {} }
    await a.start(null, { mcpServers: [launch] })
    const first = a.session()
    a.refresh("mcp")
    await a.until("lists", (event) => event.lists.mcp?.some((row) => row.state === "connected") === true)
    const sent = await a.send("YANKEE call the mod's server")
    if (!sent.ok) throw new Error(sent.problem)
    const opened = await a.until("ask.open")
    await a.answer(opened.ask.id, allow)
    await a.until("turn.end")
    await a.start({ ref: { agent: "codex", id: first }, fork: false, at: null }, { mcpServers: [launch] })
    a.refresh("mcp")
    await a.until("lists", (event) => event.lists.mcp?.some((row) => row.state === "connected") === true)
    await turn(a, "ZULU say it again")
    await a.close()
  },
  async verify(root) {
    const bodies = await readFile(join(root.root, "bodies.jsonl"), "utf8")
    if (!bodies.includes("echo: from the mod")) throw new Error("the server's answer did not reach the model")
  },
}
