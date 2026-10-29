import type { AgentScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })
const allowed = { permissions: [{ action: "read", resource: "*", effect: "allow" }] }

// While the first step streams, a prompt is steered into the turn, one is queued, and another client cancels a
// second queued one. The steered prompt lands after the step's read, before the next model request; the queued one
// after the last step.
export const steer: AgentScenario = {
  name: "steer",
  config: allowed,
  script: {
    title: "Steering",
    delayMs: 40,
    threads: [
      {
        match: "JULIET",
        steps: [
          {
            blocks: [
              { type: "text", text: "Reading the readme first, slowly, so there is time to say something more." },
              tool("read", { path: "README.md" }),
            ],
            waitMs: 300,
          },
          [{ type: "text", text: "Read it, and hello to you too." }],
          [{ type: "text", text: "The queued one is done." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("JULIET read the readme")
    await a.until("text.start")
    await a.send("JULIET steered: say hello")
    await a.send("JULIET queued: then sum up", [], "queue")
    await a.send("JULIET queued: never mind", [], "queue")
    await a.http("DELETE", `/api/session/${a.session()}/inbox/msg_prompt-4`)
    await a.until("user.dropped")
    await a.until("turn.end")
    await a.history(a.session())
    await a.close()
  },
}

// The model streams some text and then never finishes its message. A prompt is steered in, and the user interrupts: the
// text so far stays, and the steered prompt runs as the next turn. An interrupt with no turn running is refused. The
// interrupt waits for the whole text, so each run cuts it in the same place.
export const interrupt: AgentScenario = {
  name: "interrupt",
  script: {
    title: "Stopping",
    delayMs: 40,
    threads: [
      {
        match: "ZULU",
        steps: [
          { blocks: [{ type: "text", text: "Starting a long answer, and then" }], hang: true },
          [{ type: "text", text: "Stopped there. What else?" }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("ZULU write something long")
    await a.until("text.delta", (event) => event.text.endsWith("and then"))
    await a.send("ZULU steered while it hangs")
    await a.interrupt()
    await a.until("turn.end")
    await a.until("turn.end")
    await a.interrupt()
    await a.history(a.session())
    await a.close()
  },
}
