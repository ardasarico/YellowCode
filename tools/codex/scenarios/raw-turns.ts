import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { RawScenario } from "../scenario.ts"
import { prompt, startThread } from "./raw-hello.ts"

// A plain answer with a reasoning summary before it.
export const rawText: RawScenario = {
  name: "raw-text",
  script: {
    threads: [
      {
        match: "ALPHA",
        steps: [
          [
            { type: "reasoning", text: "The user wants a short greeting. One sentence is enough." },
            { type: "text", text: "Hello! How can I help with this project today?" },
          ],
        ],
      },
    ],
  },
  async steps(d) {
    const threadId = await startThread(d)
    await d.request("turn/start", { ...prompt(threadId, "ALPHA say hello"), summary: "auto" })
    await d.until("turn/completed")
  },
}

// A shell command that is not known to be safe, under the untrusted policy, so Codex asks first; it is allowed once.
export const rawShell: RawScenario = {
  name: "raw-shell",
  script: {
    threads: [
      {
        match: "SHELL",
        steps: [
          [{ type: "call", name: "exec_command", arguments: { cmd: "touch made.txt", yield_time_ms: 1000 } }],
          [{ type: "text", text: "Created made.txt." }],
        ],
      },
    ],
  },
  async steps(d) {
    const threadId = await startThread(d, { approvalPolicy: "untrusted" })
    await d.request("turn/start", prompt(threadId, "SHELL make a file"))
    const ask = await d.until("item/commandExecution/requestApproval")
    if (ask.type === "request") d.respond(ask.id, { decision: "accept" })
    await d.until("turn/completed")
  },
  async verify(root) {
    await stat(join(root.project, "made.txt"))
  },
}

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  '-export const greeting = "hello"',
  '+export const greeting = "hello, world"',
  "*** Add File: notes.md",
  "+# Notes",
  "+",
  "+Written by the patch.",
  "*** End Patch",
  "",
].join("\n")

// apply_patch edits one file and adds another inside the workspace, which the default policy allows without asking.
export const rawPatch: RawScenario = {
  name: "raw-patch",
  script: {
    threads: [
      {
        match: "PATCH",
        steps: [
          [{ type: "custom", name: "apply_patch", input: PATCH }],
          [{ type: "text", text: "Updated the greeting and added notes." }],
        ],
      },
    ],
  },
  async steps(d) {
    const threadId = await startThread(d)
    await d.request("turn/start", prompt(threadId, "PATCH change the greeting"))
    await d.until("turn/completed")
  },
  async verify(root) {
    const greeting = await readFile(join(root.project, "src", "a.ts"), "utf8")
    if (!greeting.includes("hello, world")) throw new Error("src/a.ts was not patched")
    await stat(join(root.project, "notes.md"))
  },
}
