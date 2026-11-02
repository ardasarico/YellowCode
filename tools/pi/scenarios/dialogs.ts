import type { Scenario } from "../scenario.ts"

// An extension command that asks every kind of dialog, one with a timeout left to run out, and tells what it got.
const EXTENSION = `export default function (pi) {
  pi.registerCommand("ask-all", {
    description: "Ask every kind of dialog",
    handler: async (_args, ctx) => {
      const sure = await ctx.ui.confirm("Run it?", "It touches nothing.")
      const color = await ctx.ui.select("Pick a color", ["Red", "Blue"])
      const name = await ctx.ui.input("Your name", "type it")
      const text = await ctx.ui.editor("Edit the note", "line one")
      const late = await ctx.ui.select("Too slow", ["A", "B"], { timeout: 300 })
      ctx.ui.notify("got " + JSON.stringify({ sure, color, name, text, late }), "info")
    },
  })
}
`

export const dialogs: Scenario = {
  name: "dialogs",
  script: { threads: [] },
  agent: { "extensions/ask.ts": EXTENSION },
  async steps(d) {
    void d.command("prompt", { message: "/ask-all" })
    const answers: Record<string, unknown>[] = [
      { confirmed: true },
      { value: "Blue" },
      { value: "Ada" },
      { value: "line one, edited" },
    ]
    for (const answer of answers) {
      // oxlint-disable-next-line no-await-in-loop -- each dialog opens only once the one before is answered
      const request = await d.until("extension_ui_request")
      d.answer(String(request["id"]), answer)
    }
    await d.until("extension_ui_request", (request) => request["method"] === "select")
    await d.until("extension_ui_request", (request) => request["method"] === "notify")
  },
}
