import type { AgentScenario } from "../scenario.ts"

// A 1x1 PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// One turn with thinking and text, slow enough that each block streams as several deltas. The prompt carries an
// image, and the history reads the turn back.
export const text: AgentScenario = {
  name: "text",
  script: {
    title: "Describing the pixel",
    delayMs: 60,
    threads: [
      {
        match: "GOLF",
        steps: [
          [
            { type: "thinking", thinking: "The image is a single pixel, so there is little to describe." },
            { type: "text", text: "It is one pixel, nearly transparent. There is nothing else in it." },
          ],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("GOLF what is in this image?", [{ mediaType: "image/png", base64: PIXEL }])
    await a.until("turn.end")
    await a.history(a.session())
    await a.close()
  },
}

// A turn of ours, then one another client sends, whose two steps (a read between them) count as one turn; the
// history gives our prompt its id back. Then another client deletes the session.
export const twoTurns: AgentScenario = {
  name: "two-turns",
  script: {
    title: "Two turns",
    threads: [
      { match: "HOTEL one", steps: [[{ type: "text", text: "The first turn is done." }]] },
      {
        // The longer match wins once both prompts are in the request; the first turn's reply counts as step 0.
        match: "HOTEL two, from",
        steps: [
          [],
          [
            { type: "thinking", thinking: "Read the readme first." },
            { type: "text", text: "Reading the readme." },
            { type: "tool", name: "read", input: { path: "README.md" } },
          ],
          [{ type: "text", text: "It is a small demo project." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("HOTEL one")
    await a.until("turn.end")
    await a.http("POST", `/api/session/${a.session()}/prompt`, { text: "HOTEL two, from another client" })
    await a.until("user", (event) => event.text.startsWith("HOTEL two"))
    await a.until("turn.end")
    await a.history(a.session())
    await a.http("DELETE", `/api/session/${a.session()}`)
    await a.until("ended")
  },
}

// The model API answers 500 for good: opencode retries ten times, then the turn fails.
export const error: AgentScenario = {
  name: "error",
  script: {
    title: "Broken",
    threads: [
      {
        match: "INDIA",
        always: { error: { status: 500, type: "api_error", message: "The mock is broken" } },
        steps: [],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("INDIA try this")
    await a.until("turn.end", undefined, 150_000)
    await a.close()
  },
}
