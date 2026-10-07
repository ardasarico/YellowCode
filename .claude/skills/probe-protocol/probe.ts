import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Message = Record<string, any>
type Scenario = { prompt?: string; controls?: Message[] }

const scenarios: Record<string, Scenario> = {
  text: { prompt: "Reply with the single word: ready" },
  tool: { prompt: "Run `ls` with the Bash tool, then reply with one word." },
  permission: { prompt: "Use the Write tool to create notes.txt containing 'hello'. Do nothing else." },
  subagent: {
    prompt: "Use the Agent tool with subagent_type general-purpose to list the files here, then reply with one word.",
  },
  control: {
    controls: [{ subtype: "initialize" }, { subtype: "get_context_usage", detail: "summary" }, { subtype: "mcp_status" }],
  },
}

const name = process.argv[2] ?? ""
const scenario = scenarios[name]
if (!scenario) {
  console.error(`Usage: bun probe.ts <${Object.keys(scenarios).join("|")}>`)
  process.exit(1)
}

const version = Bun.spawnSync(["claude", "--version"]).stdout.toString().split(" ")[0] ?? "unknown"
const projectDir = join(import.meta.dir, "..", "..", "..")
const outDir = join(projectDir, ".local", "probes", version)
const workDir = await mkdtemp(join(tmpdir(), "yellowcode-probe-"))

const proc = Bun.spawn(
  [
    "claude",
    "-p",
    "--input-format=stream-json",
    "--output-format=stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--permission-prompt-tool=stdio",
    "--permission-mode=default",
    "--model=haiku",
  ],
  { cwd: workDir, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
)

const send = (message: Message) => proc.stdin.write(JSON.stringify(message) + "\n")
const pendingControls = new Set<string>()

scenario.controls?.forEach((request, index) => {
  const id = `probe-${index}`
  pendingControls.add(id)
  send({ type: "control_request", request_id: id, request })
})
if (scenario.prompt) send({ type: "user", message: { role: "user", content: scenario.prompt } })

const timeout = setTimeout(() => proc.kill(), 180_000)
const messages: Message[] = []
const decoder = new TextDecoder()
let buffer = ""

read: for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline: number
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue

    const message: Message = JSON.parse(line)
    messages.push(message)

    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { behavior: "allow", updatedInput: message.request.input },
        },
      })
    }
    if (message.type === "control_response") pendingControls.delete(message.response?.request_id)

    const promptDone = !scenario.prompt || message.type === "result"
    if (promptDone && pendingControls.size === 0) break read
  }
}

proc.stdin.end()
await proc.exited
clearTimeout(timeout)
await rm(workDir, { recursive: true, force: true })

await mkdir(outDir, { recursive: true })
const outFile = join(outDir, `${name}.jsonl`)
await writeFile(outFile, messages.map((message) => JSON.stringify(message)).join("\n") + "\n")

const kindOf = (message: Message) =>
  [message.type, message.subtype ?? message.event?.type ?? message.request?.subtype].filter(Boolean).join("/")

const shorten = (value: unknown): unknown => {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}…` : value
  if (Array.isArray(value)) return value.slice(0, 3).map(shorten)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shorten(inner)]))
  }
  return value
}

const groups = Map.groupBy(messages, kindOf)
console.log(`claude ${version} · ${name} · ${messages.length} messages → ${outFile}\n`)
for (const [kind, group] of groups) console.log(`${String(group.length).padStart(4)}  ${kind}`)
for (const [kind, group] of groups) console.log(`\n== ${kind}\n${JSON.stringify(shorten(group[0]), null, 2)}`)
