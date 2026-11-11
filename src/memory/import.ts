// Claude Code's own memory of the project, brought in once: with YellowCode's memory on, claude neither reads nor
// writes its own, so what it had learned would be out of sight.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { type Ask, onceOption } from "../agent/ask.ts"
import { CLAUDE_PROJECTS } from "../agents/claude/projects.ts"
import { projectKey } from "../project-key.ts"
import { copyMemory, memoryProject, writeIndex } from "./store.ts"

const PREFIX = "memory-import-"
// Holds the answer, so the project is asked about once.
const ANSWERED = ".claude-import"

// Where claude keeps its memory of the project `cwd` is in.
export const claudeMemoryFolder = (cwd: string) => join(CLAUDE_PROJECTS, projectKey(memoryProject(cwd)), "memory")

function filesIn(source: string): string[] {
  try {
    return readdirSync(source).filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
  } catch {
    return []
  }
}

// How many memories claude has in `source`, while the question is still to ask; 0 otherwise.
export const importCount = (folder: string, source: string): number =>
  existsSync(join(folder, ANSWERED)) ? 0 : filesIn(source).length

// Records the answer and, on a yes, copies the files; the number that came in.
export function answerImport(folder: string, source: string, yes: boolean): number {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, ANSWERED), yes ? "yes\n" : "no\n", { mode: 0o600 })
  if (!yes) return 0
  let copied = 0
  for (const file of filesIn(source)) {
    try {
      if (copyMemory(folder, basename(file, ".md"), readFileSync(join(source, file), "utf8"))) copied++
    } catch {
      // A file that cannot be read stays out.
    }
  }
  writeIndex(folder)
  return copied
}

// Esc closes it unanswered, so it is asked again at the next app start.
export function importAsk(id: string, count: number): Ask {
  const text = [
    `Claude Code has ${count} ${count === 1 ? "memory" : "memories"} of its own for this project.`,
    "YellowCode's memory is shared by every provider, and Claude Code's own stays off here.",
    "Its files are copied; Claude Code's folder stays as it is.",
  ]
  return {
    id: `${PREFIX}${id}`,
    kind: "permission",
    call: null,
    tool: { name: "memory", kind: "other", mcp: null },
    title: "Bring in Claude Code's memory",
    input: null,
    target: text.join("\n"),
    preview: { type: "lines", lines: text.map((line) => ({ text: line, warn: false })) },
    writes: [],
    detail: "",
    reason: "",
    options: [
      onceOption("yes", "allow", "Yes, bring them in"),
      { ...onceOption("no", "deny", "No"), lasts: "project" },
    ],
    questions: null,
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: null,
    escCloses: true,
  }
}

export const importOf = (askId: string): string | null => (askId.startsWith(PREFIX) ? askId.slice(PREFIX.length) : null)
