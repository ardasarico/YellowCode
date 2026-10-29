import type { AgentScenario } from "../scenario.ts"
import { turn } from "./turns.ts"

const exec = (cmd: string) => ({ type: "call" as const, name: "exec_command", arguments: { cmd, yield_time_ms: 2000 } })

// Codex asks the model for a summary with a prompt of its own, which the mock answers here.
const SUMMARY = { match: "CONTEXT CHECKPOINT COMPACTION", steps: [[{ type: "text" as const, text: "We read a.ts." }]] }

// A turn of two requests (a command, then the answer) and a turn of one, each with its own token counts; the context
// is read after each, and again on the resumed thread.
export const usage: AgentScenario = {
  name: "usage",
  script: {
    threads: [
      {
        match: "OSCAR one",
        steps: [
          { output: [exec("cat src/a.ts")], usage: { input: 3000, output: 200, cached: 1000 } },
          { output: [{ type: "text", text: "It exports a greeting." }], usage: { input: 3600, output: 120 } },
        ],
      },
      { match: "OSCAR two", steps: [{ output: [{ type: "text", text: "Yes." }], usage: { input: 4000, output: 40 } }] },
    ],
  },
  async run(a) {
    await a.start()
    await a.context()
    await turn(a, "OSCAR one")
    await a.context()
    await turn(a, "OSCAR two")
    const id = a.session()
    await a.start({ ref: { agent: "codex", id }, fork: false, at: null })
    await a.until("context.used")
    await a.context()
    await a.close()
  },
}

const WINDOWS = {
  "x-codex-primary-used-percent": "42.5",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1793260000",
  "x-codex-secondary-used-percent": "100",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": "1793800000",
}

// The model's server sends the account's limits as headers: both windows with the weekly one used up, then a refusal
// with the limit reached, then none.
export const limits: AgentScenario = {
  name: "limits",
  script: {
    threads: [
      { match: "PAPA one", steps: [{ output: [{ type: "text", text: "One." }], headers: WINDOWS }] },
      {
        match: "PAPA two",
        steps: [
          {
            error: { status: 429, message: "You've hit your usage limit.", type: "usage_limit_reached" },
            headers: { ...WINDOWS, "x-codex-rate-limit-reached-type": "rate_limit_reached" },
          },
        ],
      },
      { match: "PAPA three", steps: [[{ type: "text", text: "Three." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "PAPA one")
    await turn(a, "PAPA two")
    await turn(a, "PAPA three")
    await a.close()
  },
}

// /compact between turns, then a turn that fills the context past Codex's limit, so the next prompt compacts first;
// the history gives both compactions back.
export const compact: AgentScenario = {
  name: "compact",
  top: "model_auto_compact_token_limit = 20000",
  script: {
    threads: [
      SUMMARY,
      { match: "QUEBEC one", steps: [[{ type: "text", text: "Read it." }]] },
      {
        match: "QUEBEC full",
        steps: [{ output: [{ type: "text", text: "That was long." }], usage: { input: 24000, output: 300 } }],
      },
      { match: "QUEBEC after", steps: [[{ type: "text", text: "Still here." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "QUEBEC one")
    const sent = await a.send("/compact")
    if (!sent.ok) throw new Error(sent.problem)
    await a.until("turn.end")
    await turn(a, "QUEBEC full")
    await turn(a, "QUEBEC after")
    await a.history(a.session())
    await a.close()
  },
}

// YellowCode's titler asks Codex once, on a thread of its own that /resume never lists; the title it gives is set as
// the thread's name.
export const title: AgentScenario = {
  name: "title",
  script: {
    threads: [
      { match: "ROMEO", steps: [[{ type: "text", text: "Renamed the helper." }]] },
      { match: "name the work", steps: [[{ type: "text", text: "TITLE: Helper rename\nSUMMARY: renaming" }]] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "ROMEO rename the helper")
    const answer = await a.oneShot("Messages: ROMEO rename the helper. In two lines, name the work.")
    const name = answer && /TITLE:\s*(.+)/.exec(answer)?.[1]
    if (!name) throw new Error(`no title in ${answer}`)
    const renamed = await a.rename(name)
    if (!renamed.ok) throw new Error(renamed.problem)
    await a.until("title")
    await a.sessions()
    await a.close()
  },
}
