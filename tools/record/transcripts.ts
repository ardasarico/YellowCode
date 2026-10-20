// Sessions and their steps run one at a time on purpose; each waits on a live claude process.
/* oxlint-disable no-await-in-loop */
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { ProtocolMessage } from "../../src/protocol/messages.ts"
import { parseJson } from "../../src/protocol/json.ts"
import { allowTool, renameSession, userMessage } from "../../src/protocol/outgoing.ts"
import { parse } from "../../src/protocol/parse.ts"
import { CLAUDE_STREAM_ARGS } from "../../src/source/claude-args.ts"
import { splitLines } from "../../src/source/lines.ts"
import { scrub } from "./scrub.ts"

type Step = { prompt: string } | { requestId: string; line: string }
type Spec = { name: string; files?: Record<string, string>; steps: Step[] }
type Entry = Record<string, unknown>

const SESSION_TIMEOUT_MS = 300_000
const outDir = join(import.meta.dir, "..", "..", "fixtures", "transcripts", "-Users-user-project")
const EXTRA_FILES = ["bookkeeping.jsonl", "sidechain.jsonl", "other-cwd.jsonl"]
const CHAIN_FIELDS = ["type", "uuid", "parentUuid", "isSidechain", "sessionId", "cwd", "timestamp"]

const prompts = (...texts: string[]): Step[] => texts.map((prompt) => ({ prompt }))
const specs: Spec[] = [
  {
    name: "renamed",
    steps: [
      ...prompts("Reply with the single word ready."),
      { requestId: "rename-1", line: renameSession("rename-1", "Renamed demo") },
    ],
  },
  { name: "plain", steps: prompts("Reply with the single word one.", "Reply with the single word two.") },
  {
    name: "tools",
    files: { "notes.txt": "pelican\n" },
    steps: prompts("Read notes.txt and reply with its first word."),
  },
  {
    name: "compact",
    steps: prompts("Reply with the word alpha.", "Reply with the word beta.", "/compact", "Reply with the word gamma."),
  },
  { name: "branch", steps: prompts("Reply with the word red.", "Reply with the word green.") },
  { name: "long", steps: prompts(...Array.from({ length: 25 }, (_, i) => `Reply with the number ${i + 1}.`)) },
]

const entrySchema = z.record(z.string(), z.unknown())
const promptEntry = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]),
  }),
})

function promptText(entry: Entry): string | undefined {
  const parsed = promptEntry.safeParse(entry)
  if (!parsed.success || entry.isMeta === true) return undefined
  const { content } = parsed.data.message
  return typeof content === "string" ? content : content.find((block) => block.type === "text")?.text
}

function parseEntries(text: string): Entry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const json = parseJson(line)
      if (!json.ok) throw new Error(`unreadable transcript line: ${json.error}`)
      return entrySchema.parse(json.value)
    })
}

const serialize = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
const isChain = (entry: Entry) => typeof entry.uuid === "string"

function copySession(entries: Entry[], change: (entry: Entry) => Entry): Entry[] {
  const sessionId = randomUUID()
  return entries.map((entry) => Object.assign({}, entry, "sessionId" in entry ? { sessionId } : {}, change(entry)))
}

async function run(spec: Spec, workDir: string): Promise<string> {
  for (const [path, content] of Object.entries(spec.files ?? {})) {
    await mkdir(dirname(join(workDir, path)), { recursive: true })
    await writeFile(join(workDir, path), content)
  }

  const { CLAUDE_CODE_PLUGIN_DIRS: _, ...parentEnv } = process.env
  const env = { ...parentEnv, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  const proc = Bun.spawn(
    [
      "claude",
      ...CLAUDE_STREAM_ARGS,
      "--thinking-display=summarized",
      "--safe-mode",
      "--model=haiku",
      "--permission-mode=default",
    ],
    { cwd: workDir, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  )
  const timeout = setTimeout(() => proc.kill(), SESSION_TIMEOUT_MS)
  const send = (line: string) => void proc.stdin.write(line + "\n")
  const lines = splitLines(proc.stdout)[Symbol.asyncIterator]()
  let sessionId: string | undefined

  const readUntil = async (done: (message: ProtocolMessage) => boolean) => {
    while (true) {
      const next = await lines.next()
      if (next.done) throw new Error(`${spec.name}: claude exited early`)
      const parsed = parse(next.value)
      if (parsed.kind === "unknown" && parsed.key.startsWith("system/hook_")) {
        throw new Error(`${spec.name}: hook events seen; user hooks are not isolated`)
      }
      if (parsed.kind !== "message") continue
      const message = parsed.message
      if (message.type === "system" && message.subtype === "init") sessionId ??= message.session_id
      if (message.type === "control_request" && message.request.subtype === "can_use_tool") {
        send(allowTool(message.request_id, message.request.input))
      }
      if (done(message)) return message
    }
  }

  try {
    for (const step of spec.steps) {
      if ("prompt" in step) {
        send(userMessage(step.prompt))
        const result = await readUntil((message) => message.type === "result")
        if (result.type === "result" && result.is_error) throw new Error(`${spec.name}: "${step.prompt}" failed`)
      } else {
        send(step.line)
        const reply = await readUntil(
          (message) => message.type === "control_response" && message.response.request_id === step.requestId,
        )
        if (reply.type === "control_response" && reply.response.subtype !== "success") {
          throw new Error(`${spec.name}: ${step.requestId} failed`)
        }
      }
    }
  } finally {
    void proc.stdin.end()
    await proc.exited
    clearTimeout(timeout)
  }
  if (sessionId === undefined) throw new Error(`${spec.name}: no session id`)
  return sessionId
}

function reduceAttachment(entry: Entry): Entry {
  if (entry.type !== "attachment") return entry
  const kept = Object.fromEntries(CHAIN_FIELDS.filter((field) => field in entry).map((field) => [field, entry[field]]))
  const attachment = entrySchema.safeParse(entry.attachment)
  return { ...kept, attachment: { type: attachment.success ? attachment.data.type : undefined } }
}

function addBlueBranch(entries: Entry[]): Entry[] {
  const redIndex = entries.findIndex((entry) => promptText(entry) === "Reply with the word red.")
  const greenIndex = entries.findIndex((entry) => promptText(entry) === "Reply with the word green.")
  const redReply = entries.slice(redIndex, greenIndex).findLast((entry) => entry.type === "assistant")
  const greenPrompt = entries[greenIndex]
  const greenReply = entries.slice(greenIndex).findLast((entry) => entry.type === "assistant")
  if (redIndex === -1 || !redReply || !greenPrompt || !greenReply) throw new Error("branch: red or green missing")

  const promptUuid = randomUUID()
  const prompt = {
    ...greenPrompt,
    uuid: promptUuid,
    parentUuid: redReply.uuid,
    message: { ...entrySchema.parse(greenPrompt.message), content: "Reply with the word blue." },
  }
  const reply = {
    ...greenReply,
    uuid: randomUUID(),
    parentUuid: promptUuid,
    message: { ...entrySchema.parse(greenReply.message), content: [{ type: "text", text: "blue" }] },
  }
  return [...entries, prompt, reply]
}

function addSidechainTail(entries: Entry[]): Entry[] {
  const lastMain = entries.findLast((entry) => isChain(entry) && entry.isSidechain !== true)
  const prompt = entries.find((entry) => promptText(entry) !== undefined)
  if (!lastMain || !prompt) throw new Error("tools: no main chain")
  const tail = {
    ...prompt,
    uuid: randomUUID(),
    parentUuid: lastMain.uuid,
    isSidechain: true,
    message: { role: "user", content: "Sidechain entry." },
  }
  return [...entries, tail]
}

function bookkeeping(entries: Entry[]): Entry[] {
  const sessionId = randomUUID()
  const permissionMode = entries.find((entry) => entry.type === "permission-mode") ?? {
    type: "permission-mode",
    permissionMode: "default",
  }
  const mode = entries.find((entry) => entry.type === "mode") ?? { type: "mode", mode: "normal" }
  return [
    { ...permissionMode, sessionId },
    { ...mode, sessionId },
  ]
}

function firstPrompt(path: string): string | undefined {
  for (const entry of parseEntries(readFileSync(path, "utf8"))) {
    const text = promptText(entry)
    if (text !== undefined) return text
  }
  return undefined
}

function touch(): void {
  const sessionFiles = readdirSync(outDir).filter((file) => file.endsWith(".jsonl") && !EXTRA_FILES.includes(file))
  const byPrompt = new Map(sessionFiles.map((file) => [firstPrompt(join(outDir, file)), file]))
  const ordered = specs.map((spec) => {
    const step = spec.steps[0]
    const file = step && "prompt" in step ? byPrompt.get(step.prompt) : undefined
    if (file === undefined) throw new Error(`touch: no file for ${spec.name}`)
    return file
  })
  const now = Date.now()
  for (const [k, file] of [...ordered, ...EXTRA_FILES].entries()) {
    const time = new Date(now - k * 60_000)
    utimesSync(join(outDir, file), time, time)
  }
}

async function generate(): Promise<void> {
  const requestedDir = "/tmp/yellowcode-transcripts/project"
  await rm(requestedDir, { recursive: true, force: true })
  await mkdir(requestedDir, { recursive: true })
  const workDir = await realpath(requestedDir)

  const ids = new Map<string, string>()
  try {
    for (const spec of specs) {
      console.log(`recording ${spec.name}`)
      ids.set(spec.name, await run(spec, workDir))
    }
  } finally {
    await rm(requestedDir, { recursive: true, force: true })
  }

  const paths = {
    workDirs: [workDir, workDir.replace(/^\/private/, "")],
    home: homedir(),
    username: userInfo().username,
    uid: userInfo().uid,
  }
  const projectDir = join(homedir(), ".claude", "projects", workDir.replaceAll(/[^A-Za-z0-9]/g, "-"))
  const sessions = new Map<string, Entry[]>()
  for (const [name, id] of ids) {
    const raw = parseEntries(await readFile(join(projectDir, `${id}.jsonl`), "utf8"))
    const scrubbed = raw.map((entry) => scrub(JSON.stringify(reduceAttachment(entry)), paths))
    sessions.set(name, parseEntries(scrubbed.join("\n")))
  }
  const session = (name: string) => sessions.get(name) ?? []
  const id = (name: string) => ids.get(name) ?? ""

  sessions.set("plain", [...session("plain"), { type: "ai-title", aiTitle: "Counting words", sessionId: id("plain") }])
  sessions.set("branch", addBlueBranch(session("branch")))
  sessions.set("tools", addSidechainTail(session("tools")))

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, id("plain"), "subagents"), { recursive: true })
  for (const [name, entries] of sessions) writeFileSync(join(outDir, `${id(name)}.jsonl`), serialize(entries))

  const renamed = session("renamed")
  writeFileSync(join(outDir, "bookkeeping.jsonl"), serialize(bookkeeping([...sessions.values()].flat())))
  writeFileSync(
    join(outDir, "sidechain.jsonl"),
    serialize(copySession(renamed, (entry) => (isChain(entry) ? { isSidechain: true } : {}))),
  )
  writeFileSync(
    join(outDir, "other-cwd.jsonl"),
    serialize(copySession(renamed, (entry) => ("cwd" in entry ? { cwd: "/Users/user/project-other" } : {}))),
  )
  writeFileSync(
    join(outDir, id("plain"), "subagents", "agent-a1.jsonl"),
    serialize(session("plain").filter(isChain).slice(0, 2)),
  )
}

if (!process.argv.includes("--touch")) await generate()
touch()
console.log(`wrote ${outDir}`)
