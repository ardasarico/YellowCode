import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { listSessions } from "../agents/claude/session-list.ts"
import { promptParent, readTranscript, type TranscriptPart } from "../agents/claude/transcript.ts"
import { feed } from "../agents/claude/translate.ts"
import { parseJson } from "../json.ts"
import * as outgoing from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { agentMessage } from "./agent-message.ts"
import { askServerLines, controlLines, outgoingCases, scriptedSessions, spawnArgs, type Step } from "./golden-cases.ts"
import { createSession, loadHistory, type SessionStore } from "./session.ts"

// Golden files pin what the Claude path does today. UPDATE_GOLDENS=1 writes them again.
const ROOT = join(import.meta.dir, "..", "..")
const FIXTURES = join(ROOT, "fixtures")
const GOLDENS = join(FIXTURES, "goldens")
const UPDATE = process.env["UPDATE_GOLDENS"] === "1"

// The only volatile inputs, each fixed here: the wall clock session state reads, the times of the files a listing
// sorts by, and the temporary folder the listed copy of a project lives in.
const CLOCK_MS = 1_800_000_000_000
const LISTED_NEWEST_S = 1_800_000_000
const LISTED_FOLDER = "<project>"
const TEMP_PREFIX = "yellowcode-goldens-"

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(CLOCK_MS)
})
afterAll(() => clock?.mockRestore())

const jsonl = (folder: string) =>
  readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name.slice(0, -".jsonl".length))
    .toSorted()

const SESSIONS = join(FIXTURES, "sessions")
const TRANSCRIPTS = join(FIXTURES, "transcripts")
const sessionNames = jsonl(SESSIONS)
const projects = readdirSync(TRANSCRIPTS).toSorted()
const scripted = scriptedSessions()

function json(text: string): unknown {
  const read = parseJson(text)
  if (!read.ok) throw new Error(read.error)
  return read.value
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12)
const snapshot = (session: SessionStore) => json(JSON.stringify(session.state))
const hash = (session: SessionStore) => sha(JSON.stringify(session.state))

const show = (value: unknown, from = 0) => {
  const text = value === undefined ? "(missing)" : JSON.stringify(value)
  const start = from > 40 ? from - 40 : 0
  const shown = text.slice(start, start + 200)
  return `${start > 0 ? "…" : ""}${shown}${start + 200 < text.length ? "…" : ""}`
}

// Two long texts are shown from a little before where they part.
function parted(expected: unknown, actual: unknown): string {
  const left = JSON.stringify(expected) ?? ""
  const right = JSON.stringify(actual) ?? ""
  let at = 0
  while (at < left.length && left[at] === right[at]) at++
  const from = typeof expected === "string" && typeof actual === "string" ? at : 0
  return `${show(expected, from)} -> ${show(actual, from)}`
}

const keyOrder = (map: Map<string, unknown>) => [...map.keys()].join(", ")

// Paths where two JSON values differ, key order included.
function diff(expected: unknown, actual: unknown, path = "$", out: string[] = []): string[] {
  if (out.length >= 20) return out
  const bothObjects = typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null
  if (!bothObjects || Array.isArray(expected) !== Array.isArray(actual)) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push(`${path}: ${parted(expected, actual)}`)
    return out
  }
  const before = out.length
  const left = new Map<string, unknown>(Object.entries(expected))
  const right = new Map<string, unknown>(Object.entries(actual))
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const at = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`
    diff(left.get(key), right.get(key), at, out)
  }
  if (out.length === before && keyOrder(left) !== keyOrder(right))
    out.push(`${path}: key order ${keyOrder(left)} -> ${keyOrder(right)}`)
  return out
}

// Writes the golden when updating and returns null. Otherwise returns the golden when it differs, or null.
function golden(file: string, actual: unknown): { expected: unknown } | null {
  const path = join(GOLDENS, file)
  const text = `${JSON.stringify(actual, null, 2)}\n`
  for (const machinePath of [ROOT, TEMP_PREFIX]) {
    if (text.includes(machinePath)) throw new Error(`${file} holds a path of this machine: ${machinePath}`)
  }
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return null
  }
  if (!existsSync(path)) throw new Error(`${file} is missing; run the tests with UPDATE_GOLDENS=1`)
  const stored = readFileSync(path, "utf8")
  return stored === text ? null : { expected: json(stored) }
}

function check(file: string, actual: unknown): void {
  const read = golden(file, actual)
  if (read) throw new Error(`${file} differs:\n${diff(read.expected, actual).join("\n")}`)
}

type Replay = { steps: string[]; state: unknown } & Record<string, unknown>

const storedSteps = z.looseObject({ steps: z.array(z.string()) }).catch({ steps: [] })

// A replay keeps a hash of the state after each step. Each hash covers the whole state, so only the first step that
// differs is named; the rest is compared as it is.
function checkReplay(file: string, actual: Replay, where: (index: number) => string): void {
  const read = golden(file, actual)
  if (!read) return
  const expected = storedSteps.parse(read.expected).steps
  const length = Math.max(expected.length, actual.steps.length)
  const differing = Array.from({ length }, (_, index) => index).filter(
    (index) => expected[index] !== actual.steps[index],
  )
  const { steps: _, ...rest } = actual
  const { steps: __, ...expectedRest } = z.looseObject({}).catch({}).parse(read.expected)
  const changes = diff(expectedRest, rest)
  const lines = [`${file} differs`]
  const first = differing[0]
  if (first !== undefined) {
    lines.push(`the state first differs after ${where(first)}; ${differing.length} of ${length} steps differ`)
    if (changes.length === 0) lines.push("the final state is the same; only the states between differ")
  }
  throw new Error([...lines, ...changes].join("\n"))
}

// What the session tells live rewind about the files Edit and Write found, by the step it came at.
function recordOriginals(session: SessionStore, steps: string[]): unknown[] {
  const originals: unknown[] = []
  session.onFileOriginal((id, _path, original) =>
    originals.push({ step: steps.length, id, original: original === null ? null : sha(original) }),
  )
  return originals
}

for (const name of sessionNames) {
  test(`session golden: ${name}`, () => {
    const { entries } = parseRecording(readFileSync(join(SESSIONS, `${name}.jsonl`), "utf8"))
    const session = createSession()
    const steps: string[] = []
    const fileOriginals = recordOriginals(session, steps)
    for (const entry of entries) {
      feed(session, entry.dir, parse(entry.line), entry.t)
      steps.push(hash(session))
    }
    checkReplay(`sessions/${name}.json`, { steps, fileOriginals, state: snapshot(session) }, (index) => {
      const entry = entries[index]
      return `entry ${index} (fixture line ${index + 2})${entry ? `: ${entry.dir} ${show(entry.line)}` : ""}`
    })
  })
}

const stepText = (step: Step | undefined) =>
  step === undefined ? "" : "call" in step ? `call ${step.call}` : `${step.dir} ${show(step.line)}`

for (const [name, { steps: script, emitted }] of Object.entries(scripted)) {
  test(`scripted golden: ${name}`, () => {
    const session = createSession()
    const steps: string[] = []
    const fileOriginals = recordOriginals(session, steps)
    for (const [index, step] of script.entries()) {
      if ("call" in step) step.run(session)
      else {
        const parsed = parse(step.line)
        if (parsed.kind !== "message") throw new Error(`step ${index} is no protocol message: ${step.line}`)
        feed(session, step.dir, parsed, index * 1000)
      }
      steps.push(hash(session))
    }
    checkReplay(`scripted/${name}.json`, { steps, emitted, fileOriginals, state: snapshot(session) }, (index) => {
      return `step ${index}: ${stepText(script[index])}`
    })
  })
}

type Page = { earlier: TranscriptPart["earlier"]; state: unknown }

// The first part as the app opens it, then each earlier part as it is loaded on scroll.
async function pages(path: string, open: (part: TranscriptPart) => SessionStore): Promise<Page[]> {
  let part = await readTranscript(path)
  const session = open(part)
  const shown: Page[] = [{ earlier: part.earlier, state: snapshot(session) }]
  while (part.earlier) {
    // oxlint-disable-next-line no-await-in-loop -- each part starts where the one before ended
    part = await readTranscript(path, part.earlier)
    session.prepend(part.events)
    shown.push({ earlier: part.earlier, state: snapshot(session) })
  }
  return shown
}

// The session-list open path, then the open-live path.
async function opened(path: string) {
  const viewed = await pages(path, (part) => {
    const session = createSession()
    loadHistory(session, part.events)
    return session
  })
  const continued = await pages(path, (part) => {
    const session = createSession({ starting: true })
    session.prepend(part.events)
    return session
  })
  return { viewed, continued }
}

// The last name is the newest, so the listing matches only when it sorts by time.
function listed(copy: string) {
  const names = jsonl(copy)
  names.forEach((name, index) => {
    const time = LISTED_NEWEST_S - (names.length - 1 - index) * 60
    utimesSync(join(copy, `${name}.jsonl`), time, time)
  })
  return async (cwd: string | null) => {
    const entries = await listSessions(copy, cwd)
    for (const entry of entries) entry.path = entry.path.replace(copy, LISTED_FOLDER)
    return entries
  }
}

const tempProject = (project: string) => join(mkdtempSync(join(tmpdir(), TEMP_PREFIX)), project)

for (const project of projects) {
  for (const name of jsonl(join(TRANSCRIPTS, project))) {
    test(`transcript golden: ${project}/${name}`, async () => {
      check(`transcripts/${project}/${name}.json`, await opened(join(TRANSCRIPTS, project, `${name}.jsonl`)))
    })
  }

  test(`session list golden: ${project}`, async () => {
    const copy = tempProject(project)
    cpSync(join(TRANSCRIPTS, project), copy, { recursive: true })
    const list = listed(copy)
    const cwd = project.replaceAll("-", "/")
    const listing = { byProjectKey: await list(null), byCwd: { cwd, sessions: await list(cwd) } }
    rmSync(dirname(copy), { recursive: true, force: true })
    check(`transcripts/${project}.list.json`, listing)
  })
}

const PROJECT = join(TRANSCRIPTS, "-Users-user-project")

function derive(from: string, change: (entry: Record<string, unknown>) => Record<string, unknown>): string {
  return readFileSync(join(PROJECT, `${from}.jsonl`), "utf8")
    .split("\n")
    .map((line) => {
      const entry = line ? parseJson(line) : null
      return entry?.ok && typeof entry.value === "object" && entry.value !== null
        ? JSON.stringify(change({ ...entry.value }))
        : line
    })
    .join("\n")
}

const record = z.record(z.string(), z.unknown()).catch({})

// Transcripts made at test time from the fixtures, for what no recorded one holds.
test("derived transcripts golden", async () => {
  const copy = tempProject("-Users-user-project")
  mkdirSync(copy)
  // A partial compaction marks its summary with summarizeMetadata, not isVisibleInTranscriptOnly.
  writeFileSync(
    join(copy, "partial-compact.jsonl"),
    derive("d3d5b4c6-dac7-423d-a75a-8d4ff2e74d03", (entry) => {
      if (entry["isCompactSummary"] !== true) return entry
      const { isVisibleInTranscriptOnly: _, ...rest } = entry
      return { ...rest, summarizeMetadata: { messagesSummarized: 4, userContext: "", direction: "from" } }
    }),
  )
  const prompt = "Reply with the single word ready."
  writeFileSync(
    join(copy, "agent-message.jsonl"),
    derive("d5c8a46f-b0ac-477c-8c59-21998feb2b58", (entry) => {
      const message = record.parse(entry["message"])
      if (entry["type"] !== "user" || message["content"] !== prompt) return entry
      return { ...entry, message: { ...message, content: agentMessage("task-1", 'the "reviewer"', prompt) } }
    }),
  )
  // Over the size read whole, so the list reads a head and a tail. In "large" the titles are only in the tail; in
  // "late-prompt" the first prompt is past the first head, which is read again longer.
  const lines = readFileSync(join(PROJECT, "8922f31d-e8da-4585-943e-2cf3578aa653.jsonl"), "utf8").trimEnd().split("\n")
  const padding = Array.from({ length: 160 }, (_, index) =>
    JSON.stringify({ type: "padding", n: index, text: "x".repeat(1000) }),
  )
  const titles = [
    { type: "summary", summary: "Tail summary" },
    { type: "ai-title", aiTitle: "Tail title" },
  ].map((line) => JSON.stringify(line))
  const promptAt = lines.findIndex((line) => line.includes('"type":"user"')) + 1
  const large = [...lines.slice(0, promptAt), ...padding, ...lines.slice(promptAt), ...titles]
  writeFileSync(join(copy, "large.jsonl"), `${large.join("\n")}\n`)
  writeFileSync(join(copy, "late-prompt.jsonl"), `${[...padding, ...lines].join("\n")}\n`)

  const many = join(copy, "many-prompts.jsonl")
  cpSync(join(PROJECT, "fb47eef5-11f5-442d-954f-243eb5f4bc61.jsonl"), many)
  const prompts = readFileSync(many, "utf8")
    .split("\n")
    .flatMap((line) => {
      const entry = line ? record.parse(json(line)) : {}
      const content = record.parse(entry["message"])["content"]
      const isPrompt = entry["type"] === "user" && typeof content === "string" && !entry["isMeta"]
      return isPrompt && typeof entry["uuid"] === "string" ? [entry["uuid"]] : []
    })
  const queued = {
    type: "attachment",
    uuid: "attachment-1",
    parentUuid: prompts.at(-1),
    attachment: { type: "queued_command", source_uuid: "uuid-folded", prompt: "And this" },
  }
  appendFileSync(many, `${JSON.stringify(queued)}\n`)
  const parents: Record<string, unknown> = {}
  for (const uuid of [prompts[0], prompts[1], prompts.at(-1), "uuid-folded", "uuid-missing"]) {
    // oxlint-disable-next-line no-await-in-loop -- one file, read once per uuid
    const parent = await promptParent(many, uuid ?? "")
    parents[uuid ?? ""] = parent === undefined ? "(not found)" : parent
  }
  const missing = await promptParent(join(copy, "missing.jsonl"), prompts[0] ?? "")

  const derived = {
    list: await listed(copy)(null),
    "partial-compact": await opened(join(copy, "partial-compact.jsonl")),
    "agent-message": await opened(join(copy, "agent-message.jsonl")),
    promptParent: { ...parents, "(no file)": missing === undefined ? "(not found)" : missing },
  }
  rmSync(dirname(copy), { recursive: true, force: true })
  check("transcripts/derived.json", derived)
})

test("every export of outgoing.ts has a case", () => {
  const covered = new Set(Object.keys(outgoingCases).map((name) => name.split(" ")[0]))
  expect(Object.keys(outgoing).filter((name) => !covered.has(name))).toEqual([])
})

test("outgoing golden", () => {
  // A line goes in as its JSON when that reads back to the same text, so the golden stays readable and exact.
  const lines = Object.fromEntries(
    Object.entries(outgoingCases).map(([name, line]) => {
      const read = parseJson(line)
      return [name, read.ok && JSON.stringify(read.value) === line ? read.value : line]
    }),
  )
  check("outgoing.json", lines)
})

test("spawn arguments golden", () => check("args.json", spawnArgs()))

test("own ask server golden", () => check("ask-server.json", askServerLines()))

test("controls golden", () => check("controls.json", controlLines()))

test("every fixture has a golden and every golden a fixture", () => {
  const wanted = ["outgoing.json", "args.json", "ask-server.json", "controls.json", "transcripts/derived.json"]
  for (const name of sessionNames) wanted.push(`sessions/${name}.json`)
  for (const name of Object.keys(scripted)) wanted.push(`scripted/${name}.json`)
  for (const project of projects) {
    wanted.push(`transcripts/${project}.list.json`)
    for (const name of jsonl(join(TRANSCRIPTS, project))) wanted.push(`transcripts/${project}/${name}.json`)
  }
  wanted.sort()
  const present = existsSync(GOLDENS)
    ? readdirSync(GOLDENS, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".json"))
        .toSorted()
    : []
  if (UPDATE) {
    for (const file of present) if (!wanted.includes(file)) rmSync(join(GOLDENS, file))
    return
  }
  expect(present).toEqual(wanted)
})
