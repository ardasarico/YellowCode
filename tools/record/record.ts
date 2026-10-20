// Scenarios and their turns run one at a time on purpose; each waits on a live claude process.
/* oxlint-disable no-await-in-loop */
import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { askUserQuestionInput, type AskUserQuestionInput } from "../../src/protocol/messages.ts"
import {
  allowTool,
  answerQuestions,
  getHooksListingRequest,
  getSettingsRequest,
  getSkillsDialogRequest,
  getTaskOutputRequest,
  initializeRequest,
  interruptRequest,
  stopTaskRequest,
  userMessage,
} from "../../src/protocol/outgoing.ts"
import { parse, type ParseResult } from "../../src/protocol/parse.ts"
import { CLAUDE_STREAM_ARGS } from "../../src/source/claude-args.ts"
import { splitLines } from "../../src/source/lines.ts"
import {
  HOOKS_ID,
  serializeRecording,
  SETTINGS_ID,
  SKILLS_DIALOG_ID,
  type RecordingEntry,
} from "../../src/source/recording.ts"
import { solidPng } from "./png.ts"
import { scenarios, type Scenario } from "./scenarios.ts"
import { createNames, keptNames, learnSkills, scrub, scrubPaths, scrubStreams } from "./scrub.ts"

const QUIET_MS = 3_000
const POLL_MS = 1_000
const INIT_ID = "record-init"
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

const ownsMcp = (scenario: Scenario) =>
  (scenario.args?.includes("--strict-mcp-config") ?? false) || (scenario.userMcp ?? false)

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
  // skips the settings files instead. A scenario with the user's config keeps settings, skills and plugins but
  // not hooks or MCP servers (unless it asks for the user's MCP servers, which the scrub renames), and runs as a
  // host started outside Claude Code. Plugin directories passed down by a parent Claude Code session are dropped.
  const { CLAUDE_CODE_PLUGIN_DIRS: _, ...parentEnv } = process.env
  const baseEnv = scenario.userConfig
    ? Object.fromEntries(
        Object.entries(parentEnv).filter(([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")),
      )
    : parentEnv
  const env = { ...baseEnv, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  const isolation = scenario.userConfig
    ? [...(scenario.userMcp ? [] : ["--strict-mcp-config"]), "--settings", JSON.stringify({ disableAllHooks: true })]
    : ownsMcp(scenario)
      ? ["--setting-sources", ""]
      : ["--safe-mode"]
  const proc = Bun.spawn(
    [
      "claude",
      ...CLAUDE_STREAM_ARGS,
      ...isolation,
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

  const receive = (line: string) => {
    entries.push({ t: now(), dir: "in", line })
    const parsed = parse(line)
    checkIsolation(parsed, scenario)
    return parsed
  }

  const lines = splitLines(proc.stdout)[Symbol.asyncIterator]()
  let pending = lines.next()
  const deadline = timer(SCENARIO_TIMEOUT_MS)
  const expired = deadline.done.then(() => "expired" as const)

  const bashCommands = new Map<string, string>()
  const runningShells = new Map<string, { startedAt: number; toolUseId: string | undefined }>()
  let requestCount = 0
  let nextPollAt = 0
  const requestOutput = (taskId: string) => send(getTaskOutputRequest(`record-output-${requestCount++}`, taskId))
  const shellCommand = (taskId: string) => bashCommands.get(runningShells.get(taskId)?.toolUseId ?? "") ?? ""

  const sendAndWait = async (line: string, id: string) => {
    send(line)
    while (true) {
      const next = await Promise.race([pending, deadline.done])
      if (next === null) throw new Error(`${scenario.name}: timed out`)
      if (next.done) throw new Error(`${scenario.name}: claude exited early`)
      pending = lines.next()
      const parsed = receive(next.value)
      if (
        parsed.kind === "message" &&
        parsed.message.type === "control_response" &&
        parsed.message.response.request_id === id
      )
        return
    }
  }

  try {
    if (scenario.initialize || scenario.perTaskStopAffordance || scenario.userConfig) {
      const options = scenario.perTaskStopAffordance ? { perTaskStopAffordance: true } : {}
      await sendAndWait(initializeRequest(INIT_ID, options), INIT_ID)
    }
    if (scenario.userConfig) {
      await sendAndWait(getSkillsDialogRequest(SKILLS_DIALOG_ID), SKILLS_DIALOG_ID)
      await sendAndWait(getSettingsRequest(SETTINGS_ID), SETTINGS_ID)
      await sendAndWait(getHooksListingRequest(HOOKS_ID), HOOKS_ID)
    }

    for (const turn of scenario.turns) {
      const images = turn.image
        ? [{ mediaType: "image/png" as const, base64: solidPng(32, 32, [220, 30, 30]).toString("base64") }]
        : []
      send(userMessage(turn.text, images))

      let resultAt: number | null = null
      let runningTasks = 0
      let interrupted = false
      let stopSent = false

      while (true) {
        const quietEndsAt = resultAt !== null && runningTasks === 0 ? resultAt + QUIET_MS : null
        if (quietEndsAt !== null && now() >= quietEndsAt) break
        const wakeAt = Math.min(
          now() + SCENARIO_TIMEOUT_MS,
          quietEndsAt ?? Infinity,
          runningShells.size > 0 ? nextPollAt : Infinity,
        )
        const wake = timer(Math.max(0, wakeAt - now()))
        const next = await Promise.race([pending, wake.done, expired])
        wake.cancel()
        if (next === "expired") throw new Error(`${scenario.name}: timed out`)

        if (runningShells.size > 0 && now() >= nextPollAt) {
          for (const taskId of runningShells.keys()) requestOutput(taskId)
          nextPollAt = now() + POLL_MS
        }
        const { stopShell } = turn
        if (stopShell && !stopSent) {
          for (const [taskId, shell] of runningShells) {
            if (shellCommand(taskId).includes(stopShell.command) && now() - shell.startedAt >= stopShell.afterMs) {
              stopSent = true
              send(stopTaskRequest(`record-stop-${requestCount++}`, taskId))
              break
            }
          }
        }

        if (next === null) continue
        if (next.done) throw new Error(`${scenario.name}: claude exited early`)
        pending = lines.next()

        const parsed = receive(next.value)
        const isResult = parsed.kind === "message" && parsed.message.type === "result"
        const isOwnResponse =
          parsed.kind === "message" &&
          parsed.message.type === "control_response" &&
          parsed.message.response.request_id.startsWith("record-")
        if (!isResult && !isOwnResponse) resultAt = null
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
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "tool_use" || block.name !== "Bash") continue
            const { input } = block
            if (
              typeof input === "object" &&
              input !== null &&
              "command" in input &&
              typeof input.command === "string"
            ) {
              bashCommands.set(block.id, input.command)
            }
          }
        } else if (message.type === "system" && message.subtype === "task_started") {
          if (message.task_type === "local_bash" && !message.ambient) {
            runningShells.set(message.task_id, { startedAt: now(), toolUseId: message.tool_use_id })
          }
        } else if (message.type === "system" && message.subtype === "task_notification") {
          if (runningShells.has(message.task_id)) {
            requestOutput(message.task_id)
            runningShells.delete(message.task_id)
          }
        } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
          runningTasks = message.tasks.length
        } else if (message.type === "result") {
          resultAt = now()
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
  const names = createNames(keptNames(scenario.files))
  learnSkills(
    entries.map((entry) => entry.line),
    names,
  )
  const scrubbed = scrubStreams(
    entries.map((entry) => scrub(entry.line, paths, names)),
    (text) => scrubPaths(text, paths),
  )
  const recording = {
    header: { cliVersion, scenario: scenario.name, recordedAt: new Date().toISOString() },
    entries: entries.map((entry, index) => ({ t: entry.t, dir: entry.dir, line: scrubbed[index] ?? entry.line })),
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
