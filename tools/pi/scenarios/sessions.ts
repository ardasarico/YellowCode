import { forkMessages } from "../../../src/agents/pi/wire.ts"
import { promptAndSettle } from "../driver.ts"
import type { Scenario } from "../scenario.ts"

// Two prompts, then a fork at the second: pi copies the session up to before it into a new file and goes on there.
export const fork: Scenario = {
  name: "fork",
  script: {
    threads: [
      { match: "ONE", steps: [[{ type: "text", text: "First answer." }]] },
      { match: "TWO", steps: [[{ type: "text", text: "Second answer." }]] },
      { match: "THREE", steps: [[{ type: "text", text: "Third answer, after the fork." }]] },
    ],
  },
  async steps(d) {
    await promptAndSettle(d, "ONE")
    await promptAndSettle(d, "TWO")
    await d.command("get_state")
    const listed = forkMessages.safeParse(await d.command("get_fork_messages"))
    const messages = listed.success ? listed.data.messages : []
    const second = messages.find((message) => message.text === "TWO")
    if (!second) throw new Error("no fork point for TWO")
    await d.command("fork", { entryId: second.entryId })
    await d.command("get_state")
    await promptAndSettle(d, "THREE")
    await d.command("get_messages")
  },
}
