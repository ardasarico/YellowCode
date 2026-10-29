import { text } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })

// Read a file, edit it, show it with a shell command. Shell is allowed so nothing asks.
export const rawTools: RawScenario = {
  name: "raw-tools",
  config: { permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
  script: {
    title: "Greeting change",
    threads: [
      {
        match: "BRAVO",
        steps: [
          [{ type: "text", text: "Reading the file first." }, tool("read", { path: "src/a.ts" })],
          [tool("edit", { path: "src/a.ts", oldString: '"hello"', newString: '"hello, world"' })],
          [tool("shell", { command: "cat src/a.ts" })],
          [{ type: "text", text: "The greeting now says hello, world." }],
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
    await d.http("POST", `/api/session/${id}/prompt`, { text: "BRAVO change the greeting" })
    await d.until("session.execution.succeeded")
    await d.http("GET", `/api/session/${id}/message`)
  },
}
