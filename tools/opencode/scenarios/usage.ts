import type { AgentScenario } from "../scenario.ts"

// /context before the first step, then a turn of two steps that read from the cache: the context is the last step's
// input and cache, 84k of the model's 200k.
export const usage: AgentScenario = {
  name: "usage",
  script: {
    title: "Counting tokens",
    threads: [
      {
        match: "NOVEMBER",
        steps: [
          {
            blocks: [
              { type: "text", text: "Reading the readme." },
              { type: "tool", name: "read", input: { path: "README.md" } },
            ],
            usage: { input: 1000, cacheRead: 30000, cacheWrite: 2000 },
          },
          {
            blocks: [{ type: "text", text: "It is a small demo." }],
            usage: { input: 2000, cacheRead: 80000, cacheWrite: 2000 },
          },
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.context()
    await a.send("NOVEMBER what is this project?")
    await a.until("turn.end")
    await a.context()
    await a.close()
  },
}

// A turn, then another client asks opencode to compact the session, and a turn on the summary. Then a turn that fills
// the window nearly, so opencode compacts on its own before the next prompt's step. The longer match wins once a
// summary keeps an earlier prompt in the request.
export const compact: AgentScenario = {
  name: "compact",
  script: {
    title: "Compacting",
    threads: [
      {
        match: "OSCAR one",
        steps: [
          { blocks: [{ type: "text", text: "The first turn is done." }], usage: { input: 2000, cacheRead: 150000 } },
        ],
      },
      {
        match: "OSCAR two, after",
        always: { blocks: [{ type: "text", text: "Going on from the summary." }], usage: { input: 3000 } },
        steps: [],
      },
      {
        match: "OSCAR three, near",
        always: {
          blocks: [{ type: "text", text: "The context is nearly full." }],
          usage: { input: 1000, cacheRead: 195000 },
        },
        steps: [],
      },
      {
        match: "OSCAR four, past the window",
        always: { blocks: [{ type: "text", text: "Going on after the second summary." }], usage: { input: 4000 } },
        steps: [],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("OSCAR one")
    await a.until("turn.end")
    await a.http("POST", `/api/session/${a.session()}/compact`, {})
    await a.until("compacted")
    await a.until("turn.end")
    await a.send("OSCAR two, after the summary")
    await a.until("turn.end")
    await a.send("OSCAR three, near the end of the window")
    await a.until("turn.end")
    await a.send("OSCAR four, past the window")
    await a.until("turn.end")
    await a.context()
    await a.history(a.session())
    await a.close()
  },
}

// Summaries opencode refuses: a compaction another client asks for fails on its own, and the automatic one at the next
// prompt fails that prompt's turn with the same text.
export const compactFailed: AgentScenario = {
  name: "compact-failed",
  script: {
    title: "Failing to compact",
    badSummary: true,
    threads: [
      {
        match: "PAPA one",
        steps: [
          {
            blocks: [{ type: "text", text: "The context is nearly full." }],
            usage: { input: 1000, cacheRead: 195000 },
          },
        ],
      },
      { match: "PAPA two", steps: [[{ type: "text", text: "Never reached." }]] },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("PAPA one")
    await a.until("turn.end")
    await a.http("POST", `/api/session/${a.session()}/compact`, {})
    await a.until("notice")
    await a.until("turn.end")
    await a.send("PAPA two")
    await a.until("turn.end")
    await a.history(a.session())
    await a.close()
  },
}

// A turn, then the user types /compact, which YellowCode runs through the session's compact request, then a turn on
// the summary.
export const compactCommand: AgentScenario = {
  name: "compact-command",
  script: {
    title: "Compacting by command",
    threads: [
      {
        match: "LIMA one",
        steps: [{ blocks: [{ type: "text", text: "The first turn is done." }], usage: { input: 2000 } }],
      },
      {
        match: "LIMA two, after",
        always: { blocks: [{ type: "text", text: "Going on from the summary." }], usage: { input: 3000 } },
        steps: [],
      },
    ],
  },
  async run(a) {
    await a.start()
    // As the app does at the start, so the typed /compact names a listed command.
    a.refresh("commands")
    await a.until("lists")
    await a.send("LIMA one")
    await a.until("turn.end")
    const sent = await a.send("/compact")
    if (!sent.ok) throw new Error(sent.problem)
    await a.until("compacted")
    await a.until("turn.end")
    await a.send("LIMA two, after the summary")
    await a.until("turn.end")
    await a.close()
  },
}
