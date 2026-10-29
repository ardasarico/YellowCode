import type { AskReply } from "../../../src/agent/ask.ts"
import type { Block } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })
const pick = (option: string, note: string | null = null): AskReply => ({ type: "option", option, note })
// A later prompt's request holds the earlier turns' steps too, so its thread's own steps start after them.
const after = (steps: number, blocks: Block[][]) => [...Array.from({ length: steps }, () => []), ...blocks]

// One turn: a shell call allowed once, one allowed always (the same command later runs without asking), an edit
// turned down with a note (the turn goes on) and a write allowed once. Then a call turned down without a note, which
// stops the turn, and one another client answers. Last, the saved rule is removed.
export const permissions: AgentScenario = {
  name: "permissions",
  config: {
    permissions: ["shell", "edit", "write"].map((action) => ({ action, resource: "*", effect: "ask" })),
  },
  script: {
    title: "Asking first",
    threads: [
      {
        match: "KILO",
        steps: [
          { blocks: [{ type: "text", text: "Listing first." }, tool("shell", { command: "ls" })], waitMs: 300 },
          [tool("shell", { command: "git status" })],
          [tool("shell", { command: "git status" })],
          [tool("edit", { path: "src/a.ts", oldString: '"hello"', newString: '"hi"' })],
          [tool("write", { path: "src/b.ts", content: "export const b = 1\n" })],
          [{ type: "text", text: "The tour is done." }],
        ],
      },
      { match: "LIMA again", steps: after(6, [[tool("shell", { command: "echo hi" })]]) },
      {
        match: "MIKE once more",
        steps: after(7, [[tool("shell", { command: "pwd" })], [{ type: "text", text: "Still in the project." }]]),
      },
    ],
  },
  async run(a) {
    await a.start()
    a.refresh("rules")
    await a.until("lists")
    await a.send("KILO show me around")
    let { ask } = await a.until("ask.open")
    await a.answer(ask.id, pick("once"))
    ;({ ask } = await a.until("ask.open"))
    await a.answer(ask.id, pick("always"))
    const { lists } = await a.until("lists", (event) => (event.lists.rules?.length ?? 0) > 0)
    ;({ ask } = await a.until("ask.open"))
    await a.answer(ask.id, pick("reject", "Keep the greeting as it is."))
    ;({ ask } = await a.until("ask.open"))
    await a.answer(ask.id, pick("once"))
    await a.until("turn.end")

    await a.send("LIMA again, say hi")
    ;({ ask } = await a.until("ask.open"))
    await a.answer(ask.id, pick("reject"))
    await a.until("turn.end")

    await a.send("MIKE once more, where are we")
    ;({ ask } = await a.until("ask.open"))
    await a.http("POST", `/api/session/${a.session()}/permission/${ask.id}/reply`, { decision: "once" })
    await a.until("ask.close")
    await a.until("turn.end")

    const rule = lists.rules?.[0]
    if (!rule) throw new Error("no saved rule")
    await a.removeRule(rule.id)
    await a.until("lists", (event) => event.lists.rules?.length === 0)
    await a.close()
  },
}
