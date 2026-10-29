import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { ClientTool } from "../../../src/agent/agent.ts"
import type { Ask, AskReply } from "../../../src/agent/ask.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"
import { turn } from "./turns.ts"

// A command the read-only sandbox would stop, so the model asks to run it outside, with the rule it proposes.
const escalated = (cmd: string, why: string) => ({
  type: "call" as const,
  name: "exec_command",
  arguments: {
    cmd,
    yield_time_ms: 2000,
    sandbox_permissions: "require_escalated",
    justification: why,
    prefix_rule: cmd.split(" ").slice(0, 1),
  },
})
const patch = (...lines: string[]) => ({
  type: "custom" as const,
  name: "apply_patch",
  input: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n"),
})
const say = (text: string) => [{ type: "text" as const, text }]

const pick = (option: string): AskReply => ({ type: "option", option, note: null })
const choose = (values: Record<string, string[]>): AskReply => ({
  type: "answers",
  answers: { values, fields: {}, notes: {}, note: "" },
})

// Sends a prompt and answers each ask it opens, in order, then waits for the turn's end.
async function answering(a: AgentDriver, prompt: string, replies: ((ask: Ask) => AskReply)[]): Promise<void> {
  const sent = await a.send(prompt)
  if (!sent.ok) throw new Error(sent.problem)
  for (const reply of replies) {
    // oxlint-disable-next-line no-await-in-loop -- one ask after another
    const opened = await a.until("ask.open")
    // oxlint-disable-next-line no-await-in-loop -- one ask after another
    await a.answer(opened.ask.id, reply(opened.ask))
  }
  await a.until("turn.end")
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

// In a read-only sandbox the model asks to run each command outside it. Each answer Codex offers is given once: yes,
// yes with the rule the model proposed (`touch`, so the next touch runs unasked), and no; then the model asks for
// network access for the turn.
export const permissions: AgentScenario = {
  name: "permissions",
  top: 'sandbox_mode = "read-only"\nsuppress_unstable_features_warning = true',
  config: "[features]\nrequest_permissions_tool = true\n",
  script: {
    threads: [
      {
        match: "ROMEO",
        steps: [
          [escalated("touch one.txt", "Make the first file")],
          [escalated("touch two.txt", "Make the second file")],
          [escalated("touch three.txt", "Make the third file")],
          [escalated("mkdir made", "Make a folder")],
          [
            {
              type: "call",
              name: "request_permissions",
              arguments: { permissions: { network: { enabled: true } }, reason: "Fetch the docs" },
            },
          ],
          say("Two files made, no folder."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await answering(a, "ROMEO make some files", [
      () => pick("accept"),
      () => pick("execpolicy"),
      () => pick("decline"),
      () => pick("turn"),
    ])
    await a.close()
  },
  async verify(root) {
    if (!(await exists(join(root.project, "one.txt")))) throw new Error("one.txt was not made")
    if (!(await exists(join(root.project, "two.txt")))) throw new Error("two.txt was not made")
    if (!(await exists(join(root.project, "three.txt")))) throw new Error("the rule did not hold")
    if (await exists(join(root.project, "made"))) throw new Error("the declined mkdir ran")
  },
}

// In a read-only sandbox every patch asks. The first is allowed once, the second turned down, the third allowed for
// the session, which holds for the files it named, so the fourth patch of the same file goes through unasked.
export const patchApproval: AgentScenario = {
  name: "patch-approval",
  top: 'sandbox_mode = "read-only"',
  script: {
    threads: [
      {
        match: "SIERRA",
        steps: [
          [
            patch(
              "*** Update File: src/a.ts",
              '-export const greeting = "hello"',
              '+export const greeting = "hello, world"',
              "*** Add File: notes.md",
              "+# Notes",
            ),
          ],
          [patch("*** Delete File: README.md")],
          [patch("*** Add File: two.md", "+two")],
          [patch("*** Update File: two.md", "@@", "-two", "+two again")],
          say("Patched what I could."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await answering(a, "SIERRA patch some files", [
      () => pick("accept"),
      () => pick("decline"),
      () => pick("acceptForSession"),
    ])
    await a.close()
  },
  async verify(root) {
    const greeting = await readFile(join(root.project, "src", "a.ts"), "utf8")
    if (!greeting.includes("hello, world")) throw new Error("src/a.ts was not patched")
    if (!(await exists(join(root.project, "README.md")))) throw new Error("the declined delete ran")
    const two = await readFile(join(root.project, "two.md"), "utf8")
    if (!two.includes("two again")) throw new Error("the session's yes did not hold")
  },
}

const PAGES = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [{ label: "Blue" }, { label: "Green", description: "Like grass" }],
    },
  ],
}

// Our own ask: answered, sent to the chat, and one Codex shows nobody because it breaks the tool's rules.
export const ownAsk: AgentScenario = {
  name: "own-ask",
  script: {
    threads: [
      {
        match: "TANGO",
        steps: [
          [{ type: "call", name: "ask", arguments: PAGES }],
          [{ type: "call", name: "ask", arguments: PAGES }],
          [
            {
              type: "call",
              name: "ask",
              arguments: { questions: [{ question: "Only one?", header: "One", options: [{ label: "Yes" }] }] },
            },
          ],
          say("Blue it is."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await answering(a, "TANGO ask me", [
      () => choose({ "Which color?": ["Blue"] }),
      () => ({ type: "declined", chat: true }),
    ])
    await a.close()
  },
}

// Codex's own question tool, which it offers outside Plan mode only with a feature turned on. The first request is
// answered, one question by an option and one by typed text; the second is turned down.
export const nativeQuestion: AgentScenario = {
  name: "native-question",
  top: "suppress_unstable_features_warning = true",
  config: "[features]\ndefault_mode_request_user_input = true\n",
  script: {
    threads: [
      {
        match: "UNIFORM",
        steps: [
          [
            {
              type: "call",
              name: "request_user_input",
              arguments: {
                questions: [
                  {
                    id: "color",
                    header: "Color",
                    question: "Which color?",
                    options: [
                      { label: "Blue (Recommended)", description: "Calm" },
                      { label: "Green", description: "Like grass" },
                    ],
                  },
                  {
                    id: "size",
                    header: "Size",
                    question: "How big?",
                    options: [
                      { label: "Small", description: "Fits" },
                      { label: "Large", description: "Stands out" },
                    ],
                  },
                ],
              },
            },
          ],
          [
            {
              type: "call",
              name: "request_user_input",
              arguments: {
                questions: [
                  {
                    id: "font",
                    header: "Font",
                    question: "Which font?",
                    options: [
                      { label: "Serif", description: "Classic" },
                      { label: "Sans", description: "Plain" },
                    ],
                  },
                ],
              },
            },
          ],
          say("Green and medium, no font."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await answering(a, "UNIFORM ask me with your own tool", [
      () => choose({ color: ["Green"], size: ["Medium"] }),
      () => ({ type: "declined", chat: false }),
    ])
    await a.close()
  },
}

const ASKER = await readFile(join(import.meta.dir, "..", "mcp-ask.ts"), "utf8")

function node(): string {
  const found = Bun.which("node")
  if (!found) throw new Error("the elicitation scenario needs node (23 or later) on PATH")
  return found
}

// An MCP tool that asks the user through an elicitation. Codex first asks whether the tool may run (allowed for the
// session, so the second call runs unasked); the tool's own form is answered once and turned down once.
export const elicitation: AgentScenario = {
  name: "elicitation",
  files: { ".mcp/ask.ts": ASKER },
  config: (root) =>
    ["[mcp_servers.ask]", `command = "${node()}"`, `args = ["${join(root.project, ".mcp", "ask.ts")}"]`, ""].join("\n"),
  script: {
    threads: [
      {
        match: "VICTOR",
        steps: [
          [{ type: "search", query: "pick a color" }],
          [{ type: "call", namespace: "mcp__ask", name: "pick", arguments: {} }],
          [{ type: "call", namespace: "mcp__ask", name: "pick", arguments: {} }],
          say("Blue, then nothing."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await answering(a, "VICTOR pick a color", [
      () => pick("session"),
      () => choose({ color: ["Blue"] }),
      () => ({ type: "declined", chat: false }),
    ])
    await a.close()
  },
}

const ECHO: ClientTool = {
  server: "mod-demo",
  name: "echo",
  description: "Answers with the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: null,
  run: (input) => Promise.resolve({ text: `echo: ${String(input["text"])}`, error: false }),
}

// A mod's tool as a dynamic tool: it runs, an unknown one of the same mod fails, and a resumed thread in a new
// app-server still has it.
export const modTool: AgentScenario = {
  name: "mod-tool",
  script: {
    threads: [
      {
        match: "WHISKEY",
        steps: [
          [{ type: "call", namespace: "mod-demo", name: "echo", arguments: { text: "hi" } }],
          [{ type: "call", namespace: "mod-demo", name: "shout", arguments: { text: "hi" } }],
          say("The mod said hi."),
        ],
      },
      {
        match: "XRAY",
        steps: [[{ type: "call", namespace: "mod-demo", name: "echo", arguments: { text: "again" } }], say("Again.")],
      },
    ],
  },
  async run(a) {
    await a.start(null, { clientTools: [ECHO] })
    const first = a.session()
    await turn(a, "WHISKEY call the mod")
    await a.start({ ref: { agent: "codex", id: first }, fork: false, at: null }, { clientTools: [ECHO] })
    await turn(a, "XRAY call it after a resume")
    await a.close()
  },
}
