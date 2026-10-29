import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

export async function turn(a: AgentDriver, prompt: string, images: Parameters<AgentDriver["send"]>[1] = []) {
  const sent = await a.send(prompt, images)
  if (!sent.ok) throw new Error(sent.problem)
  await a.until("turn.end")
}

// A 1×1 PNG.
export const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f4bhPwAHZALLB0SopwAAAABJRU5ErkJggg=="

// One prompt with an image, answered in streamed text.
export const text: AgentScenario = {
  name: "text",
  script: {
    threads: [
      { match: "TEXT", steps: [[{ type: "text", text: "A single pixel. The readme describes a small demo." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "TEXT what is this image?", [{ mediaType: "image/png", base64: PIXEL }])
    await a.close()
  },
}

export const twoTurns: AgentScenario = {
  name: "two-turns",
  script: {
    threads: [
      { match: "KILO one", steps: [[{ type: "text", text: "First answer." }]] },
      { match: "KILO two", steps: [[{ type: "text", text: "Second answer, after the first." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "KILO one")
    await turn(a, "KILO two")
    await a.close()
  },
}

// Thinking on: Codex asks for reasoning summaries, and the model's summary streams before its answer.
export const reasoning: AgentScenario = {
  name: "reasoning",
  script: {
    threads: [
      {
        match: "LIMA",
        steps: [
          [
            { type: "reasoning", text: "The user wants a sum. Two and two make four." },
            { type: "text", text: "Four." },
          ],
        ],
      },
    ],
  },
  async run(a) {
    await a.start(null, { thinking: true })
    await turn(a, "LIMA what is two plus two?")
    await a.close()
  },
}

// The model's server fails every time: Codex reconnects twice, then the turn fails; the next prompt goes through. A
// deprecated setting makes Codex warn at the start.
export const error: AgentScenario = {
  name: "error",
  retries: { request: 0, stream: 2 },
  config: "[features]\nweb_search_request = true\n",
  script: {
    threads: [
      { match: "MIKE broken", steps: [{ error: { status: 500, message: "The server had an error" } }] },
      { match: "MIKE again", steps: [[{ type: "text", text: "Back to normal." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "MIKE broken")
    await turn(a, "MIKE again")
    await a.close()
  },
}
