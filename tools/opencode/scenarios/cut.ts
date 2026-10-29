import { messageOf } from "../../../src/agents/opencode/prompts.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

async function turn(a: AgentDriver, prompt: string): Promise<void> {
  await a.send(prompt)
  await a.until("turn.end")
}

export const KILO_FILES = { "a.txt": "hello\n" }

// Three turns that write t1.txt, edit a.txt and write t3.txt; the conversation is cut at the second, the cut taken
// back, cut there again, and the next prompt goes on from the first turn.
export const cut: AgentScenario = {
  name: "cut",
  files: KILO_FILES,
  script: {
    title: "Cutting back",
    threads: [
      {
        match: "KILO",
        steps: [
          [{ type: "tool", name: "write", input: { path: "t1.txt", content: "one\n" } }],
          [{ type: "text", text: "One done." }],
          [{ type: "tool", name: "edit", input: { path: "a.txt", oldString: "hello", newString: "HOTEL" } }],
          [{ type: "text", text: "Two done." }],
          [{ type: "tool", name: "write", input: { path: "t3.txt", content: "three\n" } }],
          [{ type: "text", text: "Three done." }],
        ],
      },
      // A step counts the assistant messages the model is sent, so this reply comes only when it got the first turn
      // and nothing after it.
      { match: "KILO again", steps: [[], [], [{ type: "text", text: "Back after the first turn." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "KILO one")
    await turn(a, "KILO two")
    await turn(a, "KILO three")
    await a.cut("prompt-2")
    await a.undoCut()
    await a.cut("prompt-2")
    await turn(a, "KILO again")
    await a.history(a.session())
    await a.close()
  },
}

// Another client stages a cut at the second prompt, clears it and stages it again; our next prompt commits it. Then
// it cuts at our prompt and commits, and sends its own. Last it cuts at its own prompt and commits, and our next
// prompt goes out with nothing to cut.
export const cutElsewhere: AgentScenario = {
  name: "cut-elsewhere",
  script: {
    title: "Cut elsewhere",
    threads: [
      { match: "LIMA", steps: [[{ type: "text", text: "One done." }], [{ type: "text", text: "Two done." }]] },
      { match: "LIMA again", steps: [[], [{ type: "text", text: "Again, after the first." }]] },
      { match: "LIMA from elsewhere", steps: [[], [{ type: "text", text: "Elsewhere, after the first." }]] },
      { match: "LIMA last", steps: [[], [{ type: "text", text: "Last, after the first." }]] },
    ],
  },
  async run(a) {
    await a.start()
    const revert = `/api/session/${a.session()}/revert`
    await turn(a, "LIMA one")
    await turn(a, "LIMA two")
    await a.http("POST", `${revert}/stage`, { messageID: messageOf("prompt-2"), files: false })
    await a.until("cut")
    await a.http("DELETE", revert)
    await a.until("cut.undone")
    // The clear runs an empty execution, which the next stage must not find running.
    await a.pause(1000)
    await a.http("POST", `${revert}/stage`, { messageID: messageOf("prompt-2"), files: false })
    await a.until("cut")
    await turn(a, "LIMA again")
    await a.http("POST", `${revert}/stage`, { messageID: messageOf("prompt-3"), files: false })
    await a.until("cut")
    await a.http("POST", `${revert}/commit`)
    await a.http("POST", `/api/session/${a.session()}/prompt`, { id: "msg_elsewhere", text: "LIMA from elsewhere" })
    await a.until("user", (event) => event.text === "LIMA from elsewhere")
    await a.until("turn.end")
    await a.http("POST", `${revert}/stage`, { messageID: "msg_elsewhere", files: false })
    await a.until("cut")
    await a.http("POST", `${revert}/commit`)
    // The commit tells nothing; its event is only seen.
    await a.pause(500)
    await a.until("seen")
    await turn(a, "LIMA last")
    await a.history(a.session())
    await a.close()
  },
}
