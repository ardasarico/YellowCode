import { text } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

// The smallest turn: create a session, send one prompt, wait for it to finish.
export const rawHello: RawScenario = {
  name: "raw-hello",
  script: {
    title: "Hello",
    threads: [{ match: "HELLO", steps: [[{ type: "text", text: "Hello there." }]] }],
  },
  async steps(d) {
    const id = text(
      await d.http("POST", "/api/session", { location: { directory: d.directory } }),
      "body",
      "data",
      "id",
    )
    await d.http("POST", `/api/session/${id}/prompt`, { text: "HELLO" })
    await d.until("session.execution.succeeded")
  },
}
