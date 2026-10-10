// Scenarios and their turns run one at a time on purpose; each waits on a live claude process.
/* oxlint-disable no-await-in-loop */
import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { askUserQuestionInput, type AskUserQuestionInput } from "../../src/protocol/messages.ts"
import { allowTool, answerQuestions, interruptRequest, userMessage } from "../../src/protocol/outgoing.ts"
import { parse, type ParseResult } from "../../src/protocol/parse.ts"
import { CLAUDE_STREAM_ARGS } from "../../src/source/claude-args.ts"
import { splitLines } from "../../src/source/lines.ts"
import { serializeRecording, type RecordingEntry } from "../../src/source/recording.ts"
import { solidPng } from "./png.ts"
import { scenarios, type Scenario } from "./scenarios.ts"
import { scrub } from "./scrub.ts"

const QUIET_MS = 3_000
const SCENARIO_TIMEOUT_MS = 300_000
const outDir = join(import.meta.dir, "..", "..", "fixtures", "sessions")

function timer(ms: number): { done: Promise<null>; cancel: () => void } {
  let handle: Timer | undefined
  const done = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), ms)
  })
  return { done, cancel: () => clearTimeout(handle) }
}

function firstOptions(input: AskUserQuestionInput): Record<string, string> {
  return Object.fromEntries(input.questions.map((q) => [q.question, q.options[0]?.label ?? ""]))
}

const ownsMcp = (scenario: Scenario) => scenario.args?.includes("--strict-mcp-config") ?? false

function checkIsolation(parsed: ParseResult, scenario: Scenario): void {
  if (parsed.kind === "unknown" && parsed.key.startsWith("system/hook_")) {
    throw new Error(`${scenario.name}: hook events recorded; user hooks are not isolated`)
  }
  if (parsed.kind === "message" && parsed.message.type === "system" && parsed.message.subtype === "init") {
    if (parsed.message.mcp_servers.length > 0 && !ownsMcp(scenario)) {
      throw new Error(`${scenario.name}: MCP servers loaded; not isolated`)
    }
    const plugins = parsed.message.plugins?.map((plugin) => plugin.name) ?? []
    if (plugins.length > 0) console.log(`  plugins loaded (review): ${plugins.join(", ")}`)
  }
}

async function record(scenario: Scenario, cliVersion: string): Promise<void> {
  const requestedDir = join("/tmp/yellowcode-record", scenario.name)
  await rm(requestedDir, { recursive: true, force: true })
  await mkdir(requestedDir, { recursive: true })
  const workDir = await realpath(requestedDir)
  for (const [path, content] of Object.entries(scenario.files ?? {})) {
    await mkdir(dirname(join(workDir, path)), { recursive: true })
    await writeFile(join(workDir, path), content)
  }

  // --safe-mode turns off every MCP server, including --mcp-config ones, so a scenario with its own servers
  // skips the settings files instead. Plugin directories passed down by a parent Claude Code session are dropped.
  const { CLAUDE_CODE_PLUGIN_DIRS: _, ...parentEnv } = process.env
  const env = { ...parentEnv, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  const proc = Bun.spawn(
    [
      "claude",
      ...CLAUDE_STREAM_ARGS,
      ...(ownsMcp(scenario) ? ["--setting-sources", ""] : ["--safe-mode"]),
      "--model=haiku",
      "--permission-mode=default",
      ...(scenario.args ?? []),
    ],
    { cwd: workDir, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  )
  const started = performance.now()
  const entries: RecordingEntry[] = []
  const now = () => Math.round(performance.now() - started)
  const send = (line: string) => {
    entries.push({ t: now(), dir: "out", line })
    void proc.stdin.write(line + "\n")
  }

  const lines = splitLines(proc.stdout)[Symbol.asyncIterator]()
  let pending = lines.next()
  const deadline = timer(SCENARIO_TIMEOUT_MS)

  try {
    for (const turn of scenario.turns) {
      const images = turn.image
        ? [{ mediaType: "image/png" as const, base64: solidPng(32, [220, 30, 30]).toString("base64") }]
        : []
      send(userMessage(turn.text, images))

      let sawResult = false
      let runningTasks = 0
      let interrupted = false

      while (true) {
        const quiet = timer(sawResult && runningTasks === 0 ? QUIET_MS : SCENARIO_TIMEOUT_MS)
        const next = await Promise.race([pending, quiet.done, deadline.done])
        quiet.cancel()
        if (next === null) {
          if (sawResult && runningTasks === 0) break
          throw new Error(`${scenario.name}: timed out`)
        }
        if (next.done) throw new Error(`${scenario.name}: claude exited early`)
        pending = lines.next()

        entries.push({ t: now(), dir: "in", line: next.value })
        const parsed = parse(next.value)
        checkIsolation(parsed, scenario)
        if (!(parsed.kind === "message" && parsed.message.type === "result")) sawResult = false
        if (parsed.kind !== "message") continue
        const message = parsed.message

        if (message.type === "control_request" && message.request.subtype === "can_use_tool") {
          const { request } = message
          if (request.tool_name === "AskUserQuestion") {
            const input = askUserQuestionInput.parse(request.input)
            send(answerQuestions(message.request_id, input, firstOptions(input), {}))
          } else {
            send(allowTool(message.request_id, request.input))
          }
        } else if (
          turn.interruptAfterFirstText &&
          !interrupted &&
          message.type === "stream_event" &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          interrupted = true
          send(interruptRequest("record-interrupt"))
        } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
          runningTasks = message.tasks.length
        } else if (message.type === "result") {
          sawResult = true
        }
      }
    }
  } finally {
    deadline.cancel()
    void proc.stdin.end()
    proc.kill()
    await proc.exited
    await rm(workDir, { recursive: true, force: true })
  }

  const paths = {
    workDirs: [workDir, workDir.replace(/^\/private/, "")],
    home: homedir(),
    username: userInfo().username,
    uid: userInfo().uid,
  }
  const recording = {
    header: { cliVersion, scenario: scenario.name, recordedAt: new Date().toISOString() },
    entries: entries.map((entry) => ({ t: entry.t, dir: entry.dir, line: scrub(entry.line, paths) })),
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, `${scenario.name}.jsonl`), serializeRecording(recording))
}

const names = process.argv.slice(2)
const unknownNames = names.filter((name) => !scenarios.some((scenario) => scenario.name === name))
if (unknownNames.length > 0) {
  console.error(`Unknown scenarios: ${unknownNames.join(", ")}. Known: ${scenarios.map((s) => s.name).join(", ")}`)
  process.exit(1)
}

const cliVersion = Bun.spawnSync(["claude", "--version"]).stdout.toString().split(" ")[0] ?? "unknown"
for (const scenario of scenarios.filter((s) => names.length === 0 || names.includes(s.name))) {
  console.log(`recording ${scenario.name} with claude ${cliVersion}`)
  await record(scenario, cliVersion)
}
