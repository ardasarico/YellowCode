import { text } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

const shell = (command: string) => ({ type: "tool" as const, name: "shell", input: { command } })

// Two shell asks: the first allowed once, the second rejected with a note, so the turn goes on.
export const rawPermission: RawScenario = {
  name: "raw-permission",
  config: { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
  script: {
    title: "Project listing",
    threads: [
      {
        match: "CHARLIE",
        steps: [
          [shell("ls")],
          [shell("git status")],
          [{ type: "text", text: "Listed the files; skipped git status as asked." }],
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
    await d.http("POST", `/api/session/${id}/prompt`, { text: "CHARLIE look around" })
    const first = text(await d.until("permission.asked"), "data", "id")
    await d.http("POST", `/api/session/${id}/permission/${first}/reply`, { decision: "once" })
    const second = text(await d.until("permission.asked"), "data", "id")
    await d.http("POST", `/api/session/${id}/permission/${second}/reply`, {
      decision: "reject",
      message: "Not now, the listing is enough.",
    })
    await d.until("session.execution.succeeded")
    await d.http("GET", `/api/session/${id}/message`)
  },
}
