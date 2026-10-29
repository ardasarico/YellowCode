import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Item } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"
import { PIXEL, turn } from "./turns.ts"

const exec = (cmd: string) => ({ type: "call" as const, name: "exec_command", arguments: { cmd, yield_time_ms: 2000 } })
const patch = (...lines: string[]) => ({
  type: "custom" as const,
  name: "apply_patch",
  input: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n"),
})

const missing = async (path: string) => {
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`${path} is still there`)
}

// Reads, searches and runs commands, patches files (update and add, then delete and move), searches the web and looks
// at an image, all in one turn; the history gives the calls back.
export const tools: AgentScenario = {
  name: "tools",
  files: { "pic.png": Buffer.from(PIXEL, "base64") },
  script: {
    threads: [
      {
        match: "NOVEMBER",
        steps: [
          [exec("cat README.md")],
          [exec("grep -rn greeting src")],
          [exec("ls src")],
          [exec("printf 'one\\n'; sleep 0.4; printf 'two\\n'; exit 3")],
          [
            patch(
              "*** Update File: src/a.ts",
              '-export const greeting = "hello"',
              '+export const greeting = "hello, world"',
              "*** Add File: notes.md",
              "+# Notes",
              "+",
              "+Written by the patch.",
            ),
          ],
          [
            patch(
              "*** Delete File: README.md",
              "*** Update File: notes.md",
              "*** Move to: docs/notes.md",
              "@@",
              "-Written by the patch.",
              "+Moved by the patch.",
            ),
          ],
          [
            { type: "websearch", query: "codex app-server protocol" },
            { type: "call", name: "view_image", arguments: { path: "pic.png" } },
          ],
          [{ type: "text", text: "All done." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "NOVEMBER try every tool")
    await a.close()
    await a.history(first)
  },
  async verify(root) {
    const greeting = await readFile(join(root.project, "src", "a.ts"), "utf8")
    if (!greeting.includes("hello, world")) throw new Error("src/a.ts was not patched")
    const notes = await readFile(join(root.project, "docs", "notes.md"), "utf8")
    if (!notes.includes("Moved by the patch.")) throw new Error("notes.md was not moved")
    await missing(join(root.project, "README.md"))
    await missing(join(root.project, "notes.md"))
  },
}

export const ECHO = await readFile(join(import.meta.dir, "..", "..", "opencode", "mcp-echo.ts"), "utf8")

// node strips the server's types; bun lives under the real home, which the isolated app-server must not touch.
export function node(): string {
  const found = Bun.which("node")
  if (!found) throw new Error("the mcp scenario needs node (23 or later) on PATH")
  return found
}

// A local MCP server's tool, found through Codex's tool search and allowed by its config, so no approval comes.
export const mcp: AgentScenario = {
  name: "mcp",
  files: { ".mcp/echo.ts": ECHO },
  config: (root) =>
    [
      "[mcp_servers.echo]",
      `command = "${node()}"`,
      `args = ["${join(root.project, ".mcp", "echo.ts")}"]`,
      `default_tools_approval_mode = "approve"`,
      "",
    ].join("\n"),
  script: {
    threads: [
      {
        match: "OSCAR",
        steps: [
          [{ type: "search", query: "echo" }],
          [{ type: "call", namespace: "mcp__echo", name: "echo", arguments: { text: "hi there" } }],
          [{ type: "text", text: "The server said hi back." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "OSCAR echo something")
    await a.close()
  },
}

// The id the last spawn gave, from its output in the request.
export function spawned(input: Item[]): string {
  const output = input.findLast((entry) => entry.type === "function_call_output")
  const text = typeof output?.["output"] === "string" ? output["output"] : "{}"
  const found = /"agent_id":"([^"]+)"/.exec(text)
  if (!found?.[1]) throw new Error("the spawn gave no agent id")
  return found[1]
}

export const AGENTS = "multi_agent_v1"

// Codex's subagent tools come through its tool search (the multi_agent feature, on by default). The main agent
// spawns one, which lists and patches a file in a thread of its own, and waits for it. The history has the main
// thread's calls only.
export const subagent: AgentScenario = {
  name: "subagent",
  script: {
    threads: [
      {
        match: "PAPA",
        steps: [
          [{ type: "search", query: "spawn agent" }],
          [
            {
              type: "call",
              namespace: AGENTS,
              name: "spawn_agent",
              arguments: { message: "QUEBEC change the greeting" },
            },
          ],
          [
            {
              type: "call",
              namespace: AGENTS,
              name: "wait_agent",
              arguments: (input) => ({ targets: [spawned(input)], timeout_ms: 30000 }),
            },
          ],
          [{ type: "text", text: "The helper changed the greeting." }],
        ],
      },
      {
        match: "QUEBEC",
        steps: [
          [exec("ls src")],
          [patch("*** Update File: src/a.ts", '-export const greeting = "hello"', '+export const greeting = "hey"')],
          [{ type: "text", text: "The greeting now says hey." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "PAPA have a helper change the greeting")
    await a.close()
    await a.history(first)
  },
  async verify(root) {
    const greeting = await readFile(join(root.project, "src", "a.ts"), "utf8")
    if (!greeting.includes("hey")) throw new Error("the subagent did not patch src/a.ts")
  },
}
