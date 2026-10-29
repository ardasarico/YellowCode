import type { AskReply } from "../../../src/agent/ask.ts"
import { OPENCODE } from "../../../src/agents/opencode/caps.ts"
import { text } from "../driver.ts"
import type { Block } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })
const say = (words: string): Block[] => [{ type: "text", text: words }]
// opencode lists our tool in Code Mode's catalog, so the model calls it from `execute`.
const ask = (input: unknown) => tool("execute", { code: `return await tools.yellowcode.ask(${JSON.stringify(input)})` })
// A later prompt's request holds the earlier turns' steps too, so its thread's own steps start after them.
const after = (steps: number, blocks: (Block[] | { blocks: Block[]; waitMs: number })[]) => [
  ...Array.from({ length: steps }, () => []),
  ...blocks,
]
const answers = (values: Record<string, string[]>, notes: Record<string, string> = {}, note = ""): AskReply => ({
  type: "answers",
  answers: { values, fields: {}, notes, note },
})

const PAGES = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [{ label: "Blue" }, { label: "Green", description: "Like grass" }],
    },
    {
      question: "Which sizes?",
      header: "Sizes",
      multiSelect: true,
      options: [{ label: "S" }, { label: "M" }, { label: "L" }],
    },
  ],
}
const MATRIX = {
  matrix: {
    question: "How sure are you?",
    header: "Sure",
    rows: [{ label: "Tests pass" }, { label: "Docs are right" }],
    scale: ["Yes", "No", "Unsure"],
  },
}

// Our own ask over client-mcp. The main session's call opens it and the answer is the call's result; a matrix the
// user takes to the chat; a subagent's call, a broken one and one of another session are turned down unseen; an
// interrupt cancels an open one. The session's rule leaves opencode's question tool out of the model's tools.
// The calls run inside Code Mode's `execute`.
export const ownAsk: AgentScenario = {
  name: "own-ask",
  script: {
    title: "Asking our way",
    threads: [
      { match: "ALPHA", steps: [{ blocks: [ask(PAGES)], waitMs: 300 }, say("Blue in S and L.")] },
      { match: "BRAVO again", steps: after(2, [[ask(MATRIX)], say("Let us talk it over.")]) },
      {
        match: "CHARLIE third one",
        steps: after(4, [
          [tool("subagent", { agent: "general", description: "Ask for me", prompt: "DELTA child asks" })],
          say("The helper could not ask."),
        ]),
      },
      { match: "DELTA child asks", steps: [[ask(PAGES)], say("I will put it in my report.")] },
      {
        match: "ECHO with one option only",
        steps: after(6, [
          [ask({ questions: [{ question: "Sure?", header: "Sure", options: [{ label: "Yes" }] }] })],
          say("Fixed."),
        ]),
      },
      { match: "FOXTROT asked then interrupted", steps: after(8, [[ask(PAGES)]]) },
      { match: "GOLF elsewhere", steps: [[ask(PAGES)], say("Not here.")] },
      { match: "HOTEL the very last one, after everything else", steps: [], always: { blocks: say("Last one.") } },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("ALPHA pick a color")
    let opened = await a.until("ask.open")
    await a.answer(
      opened.ask.id,
      answers({ "Which color?": ["Blue"], "Which sizes?": ["S", "L"] }, { "Which color?": "Dark" }, "Thanks"),
    )
    await a.until("ask.close")
    await a.until("turn.end")

    await a.send("BRAVO again, how sure")
    opened = await a.until("ask.open")
    await a.answer(opened.ask.id, { type: "declined", chat: true })
    await a.until("ask.close")
    await a.until("turn.end")

    await a.send("CHARLIE third one, through a helper")
    await a.until("turn.end")

    await a.send("ECHO with one option only")
    await a.until("turn.end")

    await a.send("FOXTROT asked then interrupted")
    await a.until("ask.open")
    await a.interrupt()
    // opencode cancels the call over the socket before the stream tells the turn's end.
    await a.until("ask.close")
    await a.until("turn.end", (end) => end.interrupted)

    // A session of the same folder that YellowCode did not open still sees the tool.
    const other = text(
      await a.http("POST", "/api/session", { location: { directory: a.directory } }),
      "body",
      "data",
      "id",
    )
    await a.http("POST", `/api/session/${other}/prompt`, { text: "GOLF elsewhere" })
    await a.pause(3000)
    await a.http("GET", `/api/session/${other}/message`)
    // A last turn, so a replay has served the other session's call before it closes.
    await a.send("HOTEL the very last one, after everything else")
    await a.until("turn.end", (end) => !end.interrupted)
    await a.close()
  },
}

// opencode's question tool wants a description on every option.
const QUESTION = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [
        { label: "Blue", description: "Like the sea" },
        { label: "Green", description: "Like grass" },
      ],
    },
    {
      question: "Which sizes?",
      header: "Sizes",
      multiple: true,
      options: ["S", "M", "L"].map((label) => ({ label, description: `Size ${label}` })),
    },
  ],
}

// opencode's own question tool, with the session's rule taken off as another client could: its form opens in the
// same band. Answered by choice (while the stream reconnects), by a typed answer, and dismissed, which ends the turn.
// Opened again, the session gets the rule back for its next turn.
export const nativeForm: AgentScenario = {
  name: "native-form",
  script: {
    title: "Asking their way",
    threads: [
      { match: "HOTEL", steps: [{ blocks: [tool("question", QUESTION)], waitMs: 300 }, say("Blue in S and L.")] },
      {
        match: "INDIA typed",
        steps: after(2, [[tool("question", { questions: [QUESTION.questions[0]] })], say("Teal it is.")]),
      },
      { match: "JULIET dismissed", steps: after(4, [[tool("question", QUESTION)], say("Never seen.")]) },
      { match: "KILO after the resume", steps: [], always: { blocks: say("Back again.") } },
    ],
  },
  async run(a) {
    await a.start()
    await a.http("PATCH", `/api/session/${a.session()}`, { permissions: [] })
    await a.send("HOTEL pick a color")
    let opened = await a.until("ask.open")
    await a.answer(opened.ask.id, answers({ q0: ["Blue"], q1: ["S", "L"] }))
    await a.reconnect()
    await a.until("ask.close")
    await a.until("turn.end")

    await a.send("INDIA typed answer")
    opened = await a.until("ask.open")
    await a.answer(opened.ask.id, answers({ q0: ["Teal"] }))
    await a.until("ask.close")
    await a.until("turn.end")

    await a.send("JULIET dismissed")
    opened = await a.until("ask.open")
    await a.answer(opened.ask.id, { type: "declined", chat: true })
    await a.until("ask.close")
    await a.until("turn.end")
    const first = a.session()
    await a.start({ ref: { agent: OPENCODE, id: first }, fork: false, at: null })
    await a.http("GET", `/api/session/${first}`)
    await a.send("KILO after the resume")
    await a.until("turn.end")
    await a.history(first)
    await a.close()
  },
}
