import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadRecording, type RecordingEntry, serializeRecording } from "../../src/source/recording.ts"
import { loadRewindExtras } from "../../src/session/rewind.ts"

const sessionsDir = join(import.meta.dir, "..", "..", "fixtures", "sessions")
const outDir = join(import.meta.dir, "..", "..", "build")
const GAP_MS = 500
const TOUR = [
  "chat",
  "markdown",
  "markdown-extras",
  "diagrams",
  "own-blocks",
  "references",
  "thinking",
  "tools",
  "permission",
  "permission-bash",
  "mcp",
  "mcp-states",
  "ask",
  "own-ask",
  "subagent",
  "agents",
  "agents-failed",
  "nested-agents",
  "workflow",
  "background-bash",
  "shells",
  "agent-shell",
  "images",
  "read-image",
  "api-retry",
  "error",
  "commands",
  "skills",
  "plugins",
  "rewind",
]
// Ids that start over in every recording; two recordings would otherwise share a tool call.
const REPEATING_ID = /(toolu_[A-Za-z0-9]+|record-output-\d+)/g

const names = process.argv.length > 2 ? process.argv.slice(2) : TOUR
const recordings = await Promise.all(names.map((name) => loadRecording(join(sessionsDir, `${name}.jsonl`))))
const extras = await Promise.all(names.map((name) => loadRewindExtras(join(sessionsDir, `${name}.jsonl`))))

const entries: RecordingEntry[] = []
const bash = []
const conflicts = []
let prompts = 0
let start = 0
for (const [index, recording] of recordings.entries()) {
  for (const change of extras[index]?.bash ?? []) bash.push({ ...change, prompt: change.prompt + prompts })
  conflicts.push(...(extras[index]?.conflicts ?? []))
  for (const entry of recording.entries) {
    const line = entry.line.replace(REPEATING_ID, `$1x${index}`)
    if (entry.dir === "out" && line.startsWith('{"type":"user"')) prompts++
    entries.push({ ...entry, t: start + entry.t, line })
  }
  start = (entries.at(-1)?.t ?? start) + GAP_MS
}

const cliVersion =
  recordings
    .map((recording) => recording.header.cliVersion)
    .toSorted()
    .at(-1) ?? "unknown"
const header = { cliVersion, scenario: "tour", recordedAt: new Date().toISOString() }
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, "tour.jsonl"), serializeRecording({ header, entries }))
if (bash.length > 0 || conflicts.length > 0)
  await writeFile(join(outDir, "tour.rewind.json"), JSON.stringify({ bash, conflicts }, null, 2) + "\n")
console.log(`build/tour.jsonl: ${names.length} recordings, ${prompts} prompts`)
