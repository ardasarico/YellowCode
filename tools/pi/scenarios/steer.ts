import { promptAndSettle } from "../driver.ts"
import type { Scenario } from "../scenario.ts"

// A steer while a slow shell command runs; pi hands it to the model at the next step.
export const steer: Scenario = {
  name: "steer",
  script: {
    threads: [
      {
        match: "SLOW",
        steps: [
          [{ type: "call", name: "bash", arguments: { command: "sleep 1 && echo slept" } }],
          [{ type: "text", text: "Saw the steer: keeping it short." }],
        ],
      },
    ],
  },
  async steps(d) {
    await d.command("prompt", { message: "SLOW run something" })
    await d.until("tool_execution_start")
    await d.command("steer", { message: "keep it short" })
    await d.until("agent_settled")
  },
}

// A follow-up queued during a turn runs after it, in the same settle.
export const followUp: Scenario = {
  name: "follow-up",
  script: {
    threads: [
      { match: "LONG", steps: [{ output: [{ type: "text", text: "A slow answer." }], waitMs: 800 }] },
      { match: "AFTER", steps: [[{ type: "text", text: "The queued one." }]] },
    ],
  },
  async steps(d) {
    await d.command("prompt", { message: "LONG" })
    await d.until("agent_start")
    await d.command("follow_up", { message: "AFTER" })
    await d.until("agent_settled")
  },
}

// Esc: the queue is cleared, then the hanging request is aborted.
export const abort: Scenario = {
  name: "abort",
  script: {
    threads: [
      { match: "HANG", steps: [{ hang: true }] },
      { match: "QUEUED", steps: [[{ type: "text", text: "Never sent." }]] },
      { match: "AGAIN", steps: [[{ type: "text", text: "Back after the abort." }]] },
    ],
  },
  async steps(d) {
    await d.command("prompt", { message: "HANG" })
    await d.until("agent_start")
    await d.command("follow_up", { message: "QUEUED" })
    await d.pause(300)
    await d.command("clear_queue")
    await d.command("abort")
    await d.until("agent_settled")
    await promptAndSettle(d, "AGAIN")
  },
}
