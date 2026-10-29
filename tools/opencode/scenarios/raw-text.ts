import { text } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

// A plain answer with reasoning before it.
export const rawText: RawScenario = {
  name: "raw-text",
  script: {
    title: "Greeting",
    threads: [
      {
        match: "ALPHA",
        steps: [
          [
            { type: "thinking", thinking: "The user wants a short greeting. One sentence is enough." },
            { type: "text", text: "Hello! How can I help with this project today?" },
          ],
        ],
      },
    ],
  },
  async steps(d) {
    const id = text(
      await d.http("POST", "/api/session", { location: { directory: d.directory } }),
      "body",
      "data",
      "id",
    )
    await d.http("POST", `/api/session/${id}/prompt`, { text: "ALPHA say hello" })
    await d.until("session.execution.succeeded")
    await d.http("GET", `/api/session/${id}/message`)
  },
}
