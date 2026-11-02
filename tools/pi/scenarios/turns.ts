import { promptAndSettle } from "../driver.ts"
import type { Scenario } from "../scenario.ts"

// The smallest turn: one prompt, one answer.
export const hello: Scenario = {
  name: "hello",
  script: { threads: [{ match: "HELLO", steps: [[{ type: "text", text: "Hello there." }]] }] },
  steps: (d) => promptAndSettle(d, "HELLO"),
}

// A thinking pass before the answer.
export const reasoning: Scenario = {
  name: "reasoning",
  script: {
    threads: [
      {
        match: "THINK",
        steps: [
          [
            { type: "reasoning", text: "The user wants a short greeting. One sentence is enough." },
            { type: "text", text: "Hello! How can I help with this project today?" },
          ],
        ],
      },
    ],
  },
  steps: (d) => promptAndSettle(d, "THINK say hello"),
}

// Two prompts in one session; the second request carries the first turn.
export const twoTurns: Scenario = {
  name: "two-turns",
  script: {
    threads: [
      { match: "FIRST", steps: [[{ type: "text", text: "First answer." }]] },
      { match: "SECOND", steps: [[{ type: "text", text: "Second answer." }]] },
    ],
  },
  async steps(d) {
    await promptAndSettle(d, "FIRST")
    await promptAndSettle(d, "SECOND")
  },
}

// The provider fails; pi's own retries are off, so the turn ends with an error on the assistant message.
export const error: Scenario = {
  name: "error",
  script: {
    threads: [{ match: "FAIL", steps: [{ error: { status: 400, message: "The mock refused this request." } }] }],
  },
  async steps(d) {
    await d.command("set_auto_retry", { enabled: false })
    await promptAndSettle(d, "FAIL")
  },
}
