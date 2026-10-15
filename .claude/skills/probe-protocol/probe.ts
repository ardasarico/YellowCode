import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

type Message = Record<string, any>
type Step = { control: Message } | { run: string[]; stdin: string } | { waitMs: number }
type Scenario = {
  prompt?: string
  controls?: Message[]
  timeoutMs?: number
  untilNotification?: boolean
  files?: Record<string, string>
  args?: string[]
  steps?: Step[]
}

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nReply with the word ${name}.\n`
const editSkill = (name: string, state: string): Step => ({
  run: ["claude", "edit-skill-overrides", "--json"],
  stdin: JSON.stringify({ name, state }),
})
// A skill of a plugin that loads for the user, as `<plugin>:<skill>`; editing it shows the plugin lock.
const loadedPluginSkill = process.env.YC_PLUGIN_SKILL
// Installed plugins as `<plugin>@<marketplace>`, turned on and off in the temporary project's settings.
const pluginOn = process.env.YC_PLUGIN_ON
const pluginOff = process.env.YC_PLUGIN_OFF

const scenarios: Record<string, Scenario> = {
  text: { prompt: "Reply with the single word: ready" },
  tool: { prompt: "Run `ls` with the Bash tool, then reply with one word." },
  permission: { prompt: "Use the Write tool to create notes.txt containing 'hello'. Do nothing else." },
  subagent: {
    prompt: "Use the Agent tool with subagent_type general-purpose to list the files here, then reply with one word.",
  },
  "subagent-text": {
    prompt:
      "Use the Agent tool with subagent_type general-purpose; tell it to think briefly, write one sentence about what it will do, run `ls`, and reply with one word. Then reply with one word.",
  },
  control: {
    controls: [{ subtype: "initialize" }, { subtype: "get_context_usage", detail: "summary" }, { subtype: "mcp_status" }],
  },
  "shell-limit": {
    prompt:
      "Run `sleep 1900; echo survived` with Bash with run_in_background true, then reply with one word. When you are notified that it finished, reply with one word.",
    timeoutMs: 2_400_000,
    untilNotification: true,
  },
  skills: {
    args: ["--settings", '{"disableAllHooks":true}', "--strict-mcp-config"],
    files: {
      ".claude/skills/probe-on/SKILL.md": skillFile("probe-on", "Probe skill that starts on."),
      ".claude/skills/probe-off/SKILL.md": skillFile("probe-off", "Probe skill that starts off."),
      ".claude/commands/probe-cmd.md": "---\ndescription: Probe legacy command.\n---\n\nReply with the word cmd.\n",
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "plugin-a@marketplace-a": true } }),
      ".claude/settings.local.json": JSON.stringify({
        skillOverrides: { "probe-off": "off" },
        enabledPlugins: { "plugin-b@marketplace-a": true },
      }),
    },
    steps: [
      { control: { subtype: "initialize" } },
      { control: { subtype: "get_settings" } },
      { control: { subtype: "get_skills_dialog" } },
      { control: { subtype: "mcp_status" } },
      { control: { subtype: "update_settings", source: "localSettings", settings: { skillOverrides: { "probe-on": "off" } } } },
      editSkill("probe-on", "off"),
      { waitMs: 3000 },
      { control: { subtype: "reload_skills" } },
      { control: { subtype: "get_skills_dialog" } },
      { control: { subtype: "get_settings" } },
      editSkill("probe-on", "on"),
      { waitMs: 3000 },
      { control: { subtype: "reload_skills" } },
      ...(loadedPluginSkill ? [editSkill(loadedPluginSkill, "off")] : []),
      editSkill("plugin-a:skill-1", "off"),
    ],
  },
  plugins: {
    prompt: "Reply with the single word: ready",
    args: ["--settings", '{"disableAllHooks":true}'],
    files: {
      ".claude/settings.json": JSON.stringify({
        enabledPlugins: {
          ...(pluginOn ? { [pluginOn]: true } : {}),
          ...(pluginOff ? { [pluginOff]: false } : {}),
        },
      }),
    },
    steps: [
      { control: { subtype: "initialize" } },
      { control: { subtype: "get_settings" } },
      { control: { subtype: "get_skills_dialog" } },
      { control: { subtype: "mcp_status" } },
      { control: { subtype: "get_hooks_listing" } },
      { waitMs: 15_000 },
    ],
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
const root = await mkdtemp(join(tmpdir(), "yellowcode-probe-"))
const workDir = join(root, "project")
await mkdir(workDir)
for (const [path, content] of Object.entries(scenario.files ?? {})) {
  await mkdir(dirname(join(workDir, path)), { recursive: true })
  await writeFile(join(workDir, path), content)
}

const readOrNull = (path: string) => readFile(path).catch(() => null)
const guarded = [
  join(homedir(), ".claude", "settings.json"),
  join(homedir(), ".claude", "settings.local.json"),
  join(projectDir, ".claude", "settings.json"),
  join(projectDir, ".claude", "settings.local.json"),
  join(workDir, ".claude", "settings.local.json"),
]
const backups: { path: string; copy: string; existed: boolean }[] = []
if (scenario.steps) {
  await mkdir(join(root, "backup"))
  for (const [index, path] of guarded.entries()) {
    const copy = join(root, "backup", String(index))
    const existed = (await readOrNull(path)) !== null
    if (existed) await copyFile(path, copy)
    backups.push({ path, copy, existed })
  }
}

// Run as a host the user started outside Claude Code: edit-skill-overrides refuses inside a Claude Code session.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")),
)

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
    ...(scenario.args ?? []),
  ],
  { cwd: workDir, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
)

const send = (message: Message) => proc.stdin.write(JSON.stringify(message) + "\n")
const pendingControls = new Set<string>()
const controlSubtypes = new Map<string, string>()
const controlAnswered = new Map<string, () => void>()

const sendControl = (id: string, request: Message) => {
  controlSubtypes.set(id, request.subtype)
  send({ type: "control_request", request_id: id, request })
}

// get_settings holds permission rules and env, so only these fields may reach disk or the terminal.
const cutSettings = (response: Message) => ({
  keys: Object.keys(response),
  sources: response.sources?.map(({ source, settings }: Message) => ({
    source,
    enabledPlugins: settings?.enabledPlugins,
    skillOverrides: settings?.skillOverrides,
  })),
})

// Only what the plugin probe needs: initialize also carries the account, hooks carry their commands.
const cutInitialize = (response: Message) => ({
  keys: Object.keys(response),
  commands: response.commands,
  agents: response.agents,
  output_style: response.output_style,
})
const cutHooks = (response: Message) => ({
  keys: Object.keys(response),
  hookKeys: Object.keys(response.hooks?.[0] ?? {}),
  events: response.events?.map(({ name }: Message) => name),
  hooks: response.hooks?.map(({ event, matcher, source, sourceLabel, pluginName, type }: Message) => ({
    event,
    matcher,
    source,
    sourceLabel,
    pluginName,
    type,
  })),
})
const cuts: Record<string, (response: Message) => Message> = {
  get_settings: cutSettings,
  initialize: cutInitialize,
  get_hooks_listing: cutHooks,
}

scenario.controls?.forEach((request, index) => {
  const id = `probe-${index}`
  pendingControls.add(id)
  sendControl(id, request)
})
if (scenario.prompt) send({ type: "user", message: { role: "user", content: scenario.prompt } })

const started = performance.now()
const timeout = setTimeout(() => proc.kill(), scenario.timeoutMs ?? 180_000)
const messages: Message[] = []
const decoder = new TextDecoder()
let buffer = ""
let sawNotification = false

const runSteps = async (steps: Step[]) => {
  for (const [index, step] of steps.entries()) {
    if ("control" in step) {
      const id = `probe-step-${index}`
      const answered = new Promise<void>((resolve) => controlAnswered.set(id, resolve))
      sendControl(id, step.control)
      await answered
    } else if ("run" in step) {
      const child = Bun.spawn(step.run, { cwd: workDir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      void child.stdin.write(step.stdin)
      void child.stdin.end()
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      messages.push({ _run: step.run.join(" "), stdin: step.stdin, exitCode, stdout, stderr })
    } else {
      await Bun.sleep(step.waitMs)
    }
  }
}
const stepsDone = scenario.steps ? runSteps(scenario.steps).finally(() => proc.stdin.end()) : undefined

read: for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk, { stream: true })
  let newline: number
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue

    const message: Message = JSON.parse(line)
    const requestId = message.type === "control_response" ? message.response?.request_id : undefined
    const cut = requestId ? cuts[controlSubtypes.get(requestId) ?? ""] : undefined
    if (cut && message.response.response) message.response.response = cut(message.response.response)
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
    if (requestId) {
      pendingControls.delete(requestId)
      controlAnswered.get(requestId)?.()
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      sawNotification = true
      const seconds = Math.round((performance.now() - started) / 1000)
      console.log(`${seconds}s task_notification ${message.status}: ${message.summary}`)
    }

    if (stepsDone) continue
    const resultDone = message.type === "result" && (!scenario.untilNotification || sawNotification)
    const promptDone = !scenario.prompt || resultDone
    if (promptDone && pendingControls.size === 0) break read
  }
}

await stepsDone
if (!scenario.steps) proc.stdin.end()
await proc.exited
clearTimeout(timeout)

for (const { path, copy, existed } of backups) {
  const now = await readOrNull(path)
  if (!existed) {
    if (now === null) continue
    await rm(path)
    console.log(`removed ${path}`)
  } else if (!now?.equals(await readFile(copy))) {
    await copyFile(copy, path)
    console.log(`restored ${path}`)
  }
}
await rm(root, { recursive: true, force: true })

await mkdir(outDir, { recursive: true })
const outFile = join(outDir, `${name}.jsonl`)
await writeFile(outFile, messages.map((message) => JSON.stringify(message)).join("\n") + "\n")

const kindOf = (message: Message) =>
  message._run ? "_run" : [message.type, message.subtype ?? message.event?.type ?? message.request?.subtype].filter(Boolean).join("/")

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
