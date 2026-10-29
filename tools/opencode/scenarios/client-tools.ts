import type { ClientTool } from "../../../src/agent/agent.ts"
import { text } from "../driver.ts"
import type { Block } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"

const say = (words: string): Block[] => [{ type: "text", text: words }]
// opencode lists client tools in Code Mode's catalog, so the model calls them from `execute`.
const run = (code: string): Block[] => [{ type: "tool", name: "execute", input: { code } }]
// A later prompt's request holds the earlier turns' steps too, so its thread's own steps start after them.
const after = (steps: number, blocks: Block[][]) => [...Array.from({ length: steps }, () => []), ...blocks]

function tool(server: string, name: string, answer: (input: Record<string, unknown>) => string, error = false) {
  const made: ClientTool = {
    server,
    name,
    description: `The test tool ${name}.`,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: name === "echo" ? { readOnly: true, title: "Echo" } : null,
    run: (input) => Promise.resolve({ text: answer(input), error }),
  }
  return made
}

const echo = tool("mod-demo", "echo", (input) => `echo ${String(input["text"])}`)
const broken = tool("mod-demo", "broken", () => "no luck", true)
const shout = tool("mod-demo", "shout", (input) => String(input["text"]).toUpperCase())
const count = tool("mod-other", "count", () => "3")

// Client tools, as a mod's: served at the start, one socket per server; a tool added to a server and a new server
// reach the next turn, a server taken away closes its socket. A tool's error result is the call's result, and a
// session YellowCode did not open gets its call turned down.
export const modTool: AgentScenario = {
  name: "mod-tool",
  script: {
    title: "Mod tools",
    threads: [
      { match: "ALPHA", steps: [run('return await tools["mod-demo"].echo({ text: "hi" })'), say("Echoed.")] },
      {
        match: "BRAVO again",
        steps: after(2, [
          run('return [await tools["mod-demo"].shout({ text: "hey" }), await tools["mod-other"].count({})]'),
          say("Shouted and counted."),
        ]),
      },
      {
        match: "CHARLIE third one",
        steps: after(4, [run('return await tools["mod-demo"].broken({})'), say("It broke.")]),
      },
      { match: "GOLF elsewhere", steps: [run('return await tools["mod-demo"].echo({ text: "golf" })'), say("No.")] },
      { match: "HOTEL the very last one, after everything else", steps: [], always: { blocks: say("Last one.") } },
    ],
  },
  async run(a) {
    await a.setClientTools([echo, broken])
    await a.start()
    await a.send("ALPHA echo it")
    await a.until("turn.end")

    await a.setClientTools([echo, broken, shout, count])
    await a.send("BRAVO again, louder")
    await a.until("turn.end")

    await a.setClientTools([echo, broken, shout])
    await a.send("CHARLIE third one, broken")
    await a.until("turn.end")

    // A session of the same folder that YellowCode did not open still sees the tools.
    const other = text(
      await a.http("POST", "/api/session", { location: { directory: a.directory } }),
      "body",
      "data",
      "id",
    )
    await a.http("POST", `/api/session/${other}/prompt`, { text: "GOLF elsewhere" })
    await a.pause(3000)
    await a.http("GET", `/api/session/${other}/message`)
    // A last turn, so a replay has served the other session's call before it closes.
    await a.send("HOTEL the very last one, after everything else")
    await a.until("turn.end")
    await a.close()
  },
}
