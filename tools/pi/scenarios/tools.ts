import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { promptAndSettle } from "../driver.ts"
import type { Scenario } from "../scenario.ts"

// A shell command, which pi runs without asking.
export const bash: Scenario = {
  name: "bash",
  script: {
    threads: [
      {
        match: "SHELL",
        steps: [
          [{ type: "call", name: "bash", arguments: { command: "touch made.txt && ls" } }],
          [{ type: "text", text: "Created made.txt." }],
        ],
      },
    ],
  },
  steps: (d) => promptAndSettle(d, "SHELL make a file"),
  async verify(root) {
    await stat(join(root.project, "made.txt"))
  },
}

// Reads a file, edits it and writes a new one.
export const edits: Scenario = {
  name: "edits",
  script: {
    threads: [
      {
        match: "EDIT",
        steps: [
          [{ type: "call", name: "read", arguments: { path: "src/a.ts" } }],
          [
            {
              type: "call",
              name: "edit",
              arguments: {
                path: "src/a.ts",
                edits: [
                  { oldText: 'export const greeting = "hello"', newText: 'export const greeting = "hello, world"' },
                ],
              },
            },
          ],
          [{ type: "call", name: "write", arguments: { path: "notes.md", content: "# Notes\n\nWritten by pi.\n" } }],
          [{ type: "text", text: "Updated the greeting and added notes." }],
        ],
      },
    ],
  },
  steps: (d) => promptAndSettle(d, "EDIT change the greeting"),
  async verify(root) {
    const greeting = await readFile(join(root.project, "src", "a.ts"), "utf8")
    if (!greeting.includes("hello, world")) throw new Error("src/a.ts was not edited")
    await stat(join(root.project, "notes.md"))
  },
}
