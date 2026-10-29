import type { AgentScenario } from "../scenario.ts"

// The adapter connects and runs a short turn. While its shell call waits for a yes, the event stream is cut, so the
// adapter connects again and resyncs; then the call is allowed once and the turn ends.
export const connect: AgentScenario = {
  name: "connect",
  config: { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
  script: {
    title: "Looking around",
    threads: [
      {
        match: "DELTA",
        steps: [
          [
            { type: "text", text: "Let me look at the files." },
            { type: "tool", name: "shell", input: { command: "ls" } },
          ],
          [{ type: "text", text: "There is a README and a src folder." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("DELTA look around")
    const { ask } = await a.until("ask.open")
    await a.reconnect()
    await a.http("POST", `/api/session/${a.session()}/permission/${ask.id}/reply`, { decision: "once" })
    await a.until("turn.end")
  },
}
