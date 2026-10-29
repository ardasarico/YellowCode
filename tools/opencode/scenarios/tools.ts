import type { Block } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })

// Nothing asks, so the calls run as the model makes them.
const ALLOWED = ["shell", "read", "glob", "grep", "edit", "write", "webfetch", "subagent"]
const allowed = { permissions: ALLOWED.map((action) => ({ action, resource: "*", effect: "allow" })) }

// The first step waits, so the title, which opencode asks for alongside it, is always counted first.
const waited = (blocks: Block[]) => ({ blocks, waitMs: 300 })

// One call of each kind a turn: read, glob, grep, edit, a write that makes a file and one that replaces one, a shell
// command that prints over time and fails, and a fetch the proxy stops. The history reads the turn back.
export const tools: AgentScenario = {
  name: "tools",
  config: allowed,
  script: {
    title: "Tool tour",
    threads: [
      {
        match: "OSCAR",
        steps: [
          waited([{ type: "text", text: "Reading first." }, tool("read", { path: "src/a.ts" })]),
          [tool("glob", { pattern: "**/*.ts" })],
          [tool("grep", { pattern: "greeting", path: "src" })],
          [tool("edit", { path: "src/a.ts", oldString: '"hello"', newString: '"hi"' })],
          [tool("write", { path: "src/b.ts", content: "export const b = 1\n" })],
          [tool("write", { path: "README.md", content: "# demo\n\nChanged.\n" })],
          [tool("shell", { command: "for i in 1 2 3; do echo line $i; sleep 0.3; done; exit 3" })],
          [tool("webfetch", { url: "https://example.com/" })],
          [{ type: "text", text: "All done." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("OSCAR try every tool")
    await a.until("turn.end", undefined, 60_000)
    await a.history(a.session())
    await a.close()
  },
}

// A subagent that reads and edits a file, under its call. Then one whose model never answers after its first read,
// which the user stops; the main turn goes on. The history reads both subagents' sessions with their calls.
export const subagent: AgentScenario = {
  name: "subagent",
  config: allowed,
  script: {
    title: "Helpers",
    threads: [
      {
        match: "PAPA",
        steps: [
          waited([
            { type: "text", text: "Asking a helper." },
            tool("subagent", { agent: "general", description: "Change the greeting", prompt: "QUEBEC change it" }),
          ]),
          [{ type: "text", text: "The helper changed it." }],
        ],
      },
      {
        match: "QUEBEC",
        steps: [
          [tool("read", { path: "src/a.ts" })],
          [tool("edit", { path: "src/a.ts", oldString: '"hello"', newString: '"hey"' })],
          [{ type: "text", text: "The greeting now says hey." }],
        ],
      },
      {
        match: "ROMEO wait",
        steps: [
          [],
          [],
          [tool("subagent", { agent: "general", description: "Wait for ever", prompt: "SIERRA wait" })],
          [{ type: "text", text: "The helper was stopped." }],
        ],
      },
      { match: "SIERRA", steps: [[tool("read", { path: "README.md" })], { hang: true }] },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("PAPA ask a helper")
    await a.until("turn.end")
    await a.send("ROMEO wait for a helper")
    const { id } = await a.until("task.start")
    // It read a file and waits for its model now.
    await a.until("tool.end", (event) => event.status === "done")
    await a.stop(id)
    await a.until("turn.end")
    await a.history(a.session())
    await a.close()
  },
}

// A shell the model starts in the background, whose end opencode tells the model in a turn of its own; then a long
// command that Ctrl+B sends to the background and the user stops.
export const bgShell: AgentScenario = {
  name: "bg-shell",
  config: allowed,
  script: {
    title: "Background work",
    threads: [
      {
        match: "TANGO",
        steps: [
          waited([tool("shell", { command: "sleep 1; echo bg done", background: true })]),
          [{ type: "text", text: "It runs in the background." }],
          [{ type: "text", text: "The command finished." }],
        ],
      },
      {
        match: "UNIFORM runs long",
        steps: [
          [],
          [],
          [],
          [tool("shell", { command: "echo first; sleep 2; echo second; sleep 30; echo late" })],
          [{ type: "text", text: "Moved on." }],
          [{ type: "text", text: "It was stopped." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("TANGO start it in the background")
    const { id: first } = await a.until("task.start")
    await a.until("turn.end")
    await a.until("task.output", (event) => event.id === first)
    await a.until("turn.end")
    await a.send("UNIFORM runs long")
    const { id: second } = await a.until("task.start")
    await a.background()
    await a.until("turn.end")
    await a.stop(second)
    await a.until("task.end", (event) => event.id === second)
    await a.until("turn.end")
    await a.history(a.session())
    await a.close()
  },
}

// A subagent the model starts in the background, whose end opencode tells the model in a turn of its own; then a
// subagent that Ctrl+B sends to the background and that ends there.
export const bgSubagent: AgentScenario = {
  name: "bg-subagent",
  config: allowed,
  script: {
    title: "Background helpers",
    threads: [
      {
        match: "VICTOR",
        steps: [
          waited([
            tool("subagent", {
              agent: "general",
              description: "Read the readme",
              prompt: "WHISKEY read it",
              background: true,
            }),
          ]),
          [{ type: "text", text: "It runs in the background." }],
          [{ type: "text", text: "The helper finished." }],
        ],
      },
      {
        match: "WHISKEY",
        steps: [{ blocks: [tool("read", { path: "README.md" })], waitMs: 500 }, [{ type: "text", text: "A demo." }]],
      },
      {
        match: "XRAY takes a while",
        steps: [
          [],
          [],
          [],
          [tool("subagent", { agent: "general", description: "Read slowly", prompt: "YANKEE read it slowly" })],
          [{ type: "text", text: "Moved on." }],
          [{ type: "text", text: "The slow helper finished." }],
        ],
      },
      {
        match: "YANKEE",
        steps: [
          [tool("read", { path: "src/a.ts" })],
          { blocks: [{ type: "text", text: "Says hello." }], waitMs: 2500 },
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("VICTOR start a helper in the background")
    const { id: first } = await a.until("task.start")
    await a.until("turn.end")
    await a.until("task.end", (event) => event.id === first, 30_000)
    await a.until("turn.end", undefined, 30_000)
    await a.send("XRAY takes a while")
    const { id: second } = await a.until("task.start")
    await a.until("tool.end", (event) => event.status === "done")
    await a.background()
    await a.until("turn.end")
    await a.until("task.end", (event) => event.id === second, 30_000)
    await a.until("turn.end", undefined, 30_000)
    await a.history(a.session())
    await a.close()
  },
}
