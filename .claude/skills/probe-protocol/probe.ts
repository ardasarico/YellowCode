import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { allowTool, answerQuestions, mcpAck, mcpResponse } from "../../../src/protocol/outgoing.ts"

type Message = Record<string, any>
type Step =
  | { control: Message | ((seen: Message[]) => Message) }
  | { send: Message }
  | { until: (message: Message) => boolean }
  | { signal: NodeJS.Signals }
  | { run: string[]; stdin: string }
  | { waitMs: number }
type Scenario = {
  prompt?: string
  controls?: Message[]
  timeoutMs?: number
  untilNotification?: boolean
  files?: Record<string, string>
  args?: string[]
  steps?: Step[]
  permissionMode?: string
  // An empty CLAUDE_CONFIG_DIR and no ANTHROPIC_* variables: the keychain is only asked for this directory's own entry.
  isolatedConfig?: boolean
  // The line answering a can_use_tool request; undefined leaves it unanswered.
  answer?: (request: Message) => string | undefined
  // null launches without --model, as YellowCode does.
  model?: string | null
  // A shell command run in the project before claude starts.
  setup?: string
  // In-process MCP servers the probe answers mcp_message for, by server name: their tools echo their input.
  sdkServers?: Record<string, { name: string; description: string }[]>
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

const user = (text: string, extra: Message = {}): Step => ({
  send: { type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, ...extra },
})
const interrupt: Step = {
  send: { type: "control_request", request_id: "interrupt", request: { subtype: "interrupt" } },
}
const is = (type: string, subtype?: string) => (message: Message) =>
  message.type === type && (subtype === undefined || (message.subtype ?? message.request?.subtype) === subtype)
const toolUse =
  (name: string, match: (input: Message) => boolean = () => true) =>
  (message: Message) =>
    message.type === "assistant" &&
    message.message.content.some(
      (block: Message) => block.type === "tool_use" && block.name === name && match(block.input),
    )
const backgroundTaskOutput = (seen: Message[]) => ({
  subtype: "get_task_output",
  task_id: seen.find((message) => message.subtype === "task_started" && message.is_backgrounded)?.task_id,
})
const queue = (extra: Message = {}): Scenario => ({
  steps: [
    user("Run `sleep 6` with the Bash tool, then reply with one word."),
    { until: toolUse("Bash") },
    { waitMs: 1000 },
    user("Also name the capital of France in one word.", extra),
    { until: is("result") },
    { waitMs: 15_000 },
  ],
})
const writeNotes = "Use the Write tool to create notes.txt containing 'hello'. Do nothing else."
const ready = "Reply with the single word: ready"
const turn = (text: string): Step[] => [user(text), { until: is("result") }]
const settings: Step = { control: { subtype: "get_settings" } }
const control = (subtype: string, fields: Message = {}): Step => ({ control: { subtype, ...fields } })
const think = (a: number, b: number) =>
  `Think it through step by step: what is ${a} * ${b}? Reply with only the number.`
const writeLater = (path: string, content: string): Step => ({
  run: ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
  stdin: content,
})
// The probe session's own transcript: the line types in order, then the title and name lines in full.
const transcriptTitles: Step = {
  run: [
    "sh",
    "-c",
    `cd "$HOME/.claude/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')" && jq -c .type *.jsonl | uniq -c && jq -c 'select(.type | test("title|name"))' *.jsonl`,
  ],
  stdin: "",
}
// A fixed number of polls: the _sent times show when the answer stopped being empty.
const pollFiles = (query: string, times: number): Step[] =>
  Array.from({ length: times }, (): Step[] => [control("file_suggestions", { query }), { waitMs: 100 }]).flat()
// The number of tracked files in the big repo of the c-p2 scenarios.
const bigFiles = Number(process.env.YC_BIG_FILES ?? 30_000)
const bigRepo =
  `git init -q && mkdir big && cd big && seq -f 'f%.0f.txt' 1 ${bigFiles} | xargs touch && cd .. && git add -A`

const scenarios: Record<string, Scenario> = {
  "mcp-set": {
    sdkServers: { "mod-probe": [{ name: "echo", description: "Returns the text it is given." }] },
    steps: [
      ...turn(ready),
      control("mcp_set_servers", { servers: { "mod-probe": { type: "sdk", name: "mod-probe" } } }),
      control("mcp_status"),
      ...turn("Call the echo tool of the mod-probe MCP server with the text hi, then reply with what it returned."),
      control("mcp_set_servers", { servers: {} }),
      control("mcp_status"),
      ...turn("Is a tool named echo from the mod-probe server still available to you? Reply yes or no."),
    ],
  },
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
  "init-timing": { steps: [{ control: { subtype: "initialize" } }, { waitMs: 10_000 }] },
  queue: queue(),
  "queue-now": queue({ priority: "now" }),
  "queue-later": queue({ priority: "later" }),
  "queue-uuid": queue({ uuid: crypto.randomUUID() }),
  interrupt: {
    steps: [
      user("Run `sleep 20` with the Bash tool, then reply with one word."),
      { until: toolUse("Bash") },
      { waitMs: 5000 },
      interrupt,
      { until: is("result") },
      user("Reply with the single word: again"),
      { until: is("result") },
    ],
  },
  "interrupt-ask": {
    answer: () => undefined,
    steps: [
      user(writeNotes),
      { until: is("control_request", "can_use_tool") },
      { waitMs: 1000 },
      interrupt,
      { until: is("result") },
      { waitMs: 3000 },
    ],
  },
  "background-interrupt": {
    steps: [
      user(
        "Run two Bash commands one after the other: first `sleep 30; echo bg-done` with run_in_background true, then `sleep 20` in the foreground. Then reply with one word.",
      ),
      { until: toolUse("Bash", (input) => input.command.includes("sleep 20")) },
      { waitMs: 2000 },
      interrupt,
      { until: is("result") },
      { control: backgroundTaskOutput },
      { until: is("system", "task_notification") },
      { control: backgroundTaskOutput },
      { waitMs: 10_000 },
    ],
  },
  multiselect: {
    answer: (request) =>
      answerQuestions(
        request.request_id,
        request.request.input,
        { [request.request.input.questions[0].question]: "Red, Green" },
        {},
      ),
    steps: [
      user(
        "Call AskUserQuestion once with one question: header 'Colors', question 'Which colors do you like?', multiSelect true, options Red, Green and Blue. Then quote the tool result you received word for word.",
      ),
      { until: is("result") },
    ],
  },
  "auto-mode": {
    permissionMode: "auto",
    // The user's own allow rules would decide the Bash call before the classifier does.
    args: ["--setting-sources", "project"],
    steps: [
      { control: { subtype: "initialize" } },
      user(writeNotes),
      { until: is("result") },
      user("Run `curl -sI https://example.com` with the Bash tool, then reply with one word."),
      { until: is("result") },
    ],
  },
  "stdin-close": { steps: [user("Reply with the single word: ready"), { until: is("result") }] },
  sigterm: {
    steps: [
      user("Run `sleep 20` with the Bash tool, then reply with one word."),
      { until: toolUse("Bash") },
      { waitMs: 2000 },
      { signal: "SIGTERM" },
    ],
  },
  unauthenticated: {
    isolatedConfig: true,
    steps: [user("Reply with the single word: ready"), { until: is("result") }],
  },
  "c-initialize": {
    model: null,
    steps: [control("initialize"), settings, control("list_models"), control("initialize"), settings],
  },
  "c-model": {
    timeoutMs: 300_000,
    steps: [
      control("initialize"),
      settings,
      control("set_model", { model: "sonnet" }),
      settings,
      ...turn(ready),
      control("set_model", { model: "claude-haiku-5-5" }),
      settings,
      ...turn(ready),
      control("set_model", { model: "haiku" }),
      settings,
      control("set_model", { model: "claude-nonexistent-9" }),
      settings,
      ...turn(ready),
      control("set_model", { model: "default" }),
      settings,
      control("set_model", { model: null }),
      settings,
    ],
  },
  "c-effort": {
    timeoutMs: 300_000,
    steps: [
      settings,
      control("apply_flag_settings", { settings: { effortLevel: "low" } }),
      settings,
      ...turn(ready),
      control("apply_flag_settings", { settings: { effortLevel: "max" } }),
      settings,
      control("apply_flag_settings", { settings: { effortLevel: "bogus" } }),
      settings,
      control("apply_flag_settings", { settings: { ultracode: true } }),
      settings,
      ...turn(`${ready}. Do not use any tools.`),
      control("apply_flag_settings", { settings: { effortLevel: null, ultracode: null } }),
      settings,
      control("apply_flag_settings", { settings: { effortLevel: "low" } }),
      control("set_model", { model: "sonnet" }),
      settings,
    ],
  },
  "c-thinking": {
    timeoutMs: 300_000,
    args: ["--thinking-display=summarized", "--effort=max"],
    steps: [
      ...turn(think(37, 43)),
      control("set_max_thinking_tokens", { thinking_display: "omitted" }),
      ...turn(think(58, 67)),
      control("set_max_thinking_tokens", { thinking_display: "highlights" }),
      ...turn(think(29, 71)),
      control("set_max_thinking_tokens", { max_thinking_tokens: null, thinking_display: null }),
    ],
  },
  "c-thinking-omitted": {
    args: ["--thinking-display=omitted", "--effort=max"],
    steps: [
      ...turn(think(37, 43)),
      control("set_max_thinking_tokens", { thinking_display: "summarized" }),
      ...turn(think(58, 67)),
    ],
  },
  "c-permission-mode": {
    timeoutMs: 300_000,
    steps: [
      control("set_permission_mode", { mode: "acceptEdits" }),
      ...turn(ready),
      control("set_permission_mode", { mode: "plan" }),
      control("set_permission_mode", { mode: "auto" }),
      control("set_permission_mode", { mode: "bypassPermissions" }),
      control("set_permission_mode", { mode: "dontAsk" }),
      control("set_permission_mode", { mode: "manual" }),
      ...turn(ready),
      control("set_permission_mode", { mode: "default" }),
      control("initialize"),
    ],
  },
  "c-permission-bypass": {
    args: ["--allow-dangerously-skip-permissions"],
    steps: [
      control("set_permission_mode", { mode: "bypassPermissions" }),
      ...turn(ready),
      control("set_permission_mode", { mode: "default" }),
      control("set_permission_mode", { mode: "bypassPermissions" }),
    ],
  },
  "c-files": {
    files: {
      "src/main.ts": "",
      "src/my file.ts": "",
      "docs/read me.md": "",
      "Notes Folder/inner.txt": "",
      ".hidden/secret.txt": "",
      ".probe-rc": "",
      "ignored.log": "",
      ".gitignore": "ignored.log\n",
    },
    steps: [
      { run: ["sh", "-c", "git init -q && git add -A && touch untracked.txt"], stdin: "" },
      control("file_suggestions", { query: "my" }),
      { waitMs: 3000 },
      ...["", "my", "my f", "my\\ f", "read me", "Notes F", "notes/", "Notes Folder/", ".hid", "src/", "ignored"].map(
        (query) => control("file_suggestions", { query }),
      ),
      control("file_suggestions", { query: "untracked" }),
      { waitMs: 5000 },
      control("file_suggestions", { query: "untracked" }),
    ],
  },
  "c-commands-changed": {
    args: ["--settings", '{"disableAllHooks":true}'],
    files: {
      "sub/.claude/skills/probe-sub/SKILL.md": skillFile("probe-sub", "Probe skill in a subdirectory."),
      "sub/notes.txt": "hello\n",
    },
    steps: [
      control("initialize"),
      writeLater(
        ".claude/commands/probe-added-cmd.md",
        "---\ndescription: Probe added command.\n---\n\nReply with added.\n",
      ),
      { waitMs: 5000 },
      writeLater(".claude/skills/probe-added/SKILL.md", skillFile("probe-added", "Probe skill added mid-session.")),
      { waitMs: 5000 },
      control("reload_skills"),
      { waitMs: 2000 },
      ...turn("Read sub/notes.txt with the Read tool, then reply with one word."),
      { waitMs: 3000 },
    ],
  },
  "c-rename": {
    steps: [
      ...turn(ready),
      { waitMs: 8000 },
      transcriptTitles,
      control("rename_session", { title: "Probe host title", source: "host" }),
      control("rename_session", { title: "Probe remote title" }),
      { waitMs: 2000 },
      transcriptTitles,
    ],
  },
  "c-append-prompt": {
    args: [
      "--forward-subagent-text",
      "--thinking-display=summarized",
      "--append-system-prompt",
      "The probe marker is AMBER-HERON-71.",
    ],
    steps: turn("What is the probe marker in your instructions? Reply with the marker only."),
  },
  "c-p2-warm": {
    files: { "src/my file.ts": "" },
    setup: bigRepo,
    steps: [control("file_suggestions", { query: "" }), ...pollFiles("my file", 150)],
  },
  "c-p2-late": {
    files: { "src/my file.ts": "" },
    setup: bigRepo,
    steps: [{ waitMs: 10_000 }, ...pollFiles("my file", 100)],
  },
  "c-p3-busy": {
    files: { "notes.txt": "" },
    steps: [
      control("file_suggestions", { query: "" }),
      user("Run `sleep 8` with the Bash tool, then reply with one word."),
      { until: toolUse("Bash") },
      { waitMs: 1000 },
      control("file_suggestions", { query: "notes" }),
      control("set_model", { model: "claude-haiku-4-5-20251001" }),
      control("apply_flag_settings", { settings: { effortLevel: "low" } }),
      settings,
      { until: is("result") },
      settings,
    ],
  },
  "c-p4-auto-off": {
    permissionMode: "auto",
    args: ["--settings", '{"disableAutoMode":"disable"}'],
    steps: [control("initialize"), ...turn(ready), control("set_permission_mode", { mode: "auto" })],
  },
  "c-p6-bypass-start": {
    permissionMode: "bypassPermissions",
    args: ["--allow-dangerously-skip-permissions"],
    steps: [control("initialize"), ...turn(ready)],
  },
  // Isolated: /model and /effort save to the user's settings file, and no model call is needed.
  "c-p7-local": {
    isolatedConfig: true,
    steps: [
      ...turn("/model sonnet"),
      settings,
      ...turn("/effort low"),
      settings,
      ...turn("/rename Probe typed name"),
    ],
  },
  "c-p12-rename": { steps: [...turn("/rename Probe typed name"), { waitMs: 1000 }, transcriptTitles] },
  "c-p9-ultracode-model": {
    steps: [
      settings,
      control("set_model", { model: "claude-haiku-4-5-20251001" }),
      settings,
      control("apply_flag_settings", { settings: { ultracode: true } }),
      settings,
      control("set_model", { model: "haiku" }),
      settings,
    ],
  },
  "c-p9-no-workflows": {
    args: ["--settings", '{"disableWorkflows":true}'],
    steps: [settings, control("apply_flag_settings", { settings: { ultracode: true } }), settings],
  },
  "c-p11-set-mode": {
    answer: (request) => allowTool(request.request_id, request.request.input, request.request.permission_suggestions),
    steps: [...turn(writeNotes), ...turn(ready)],
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
if (scenario.setup) Bun.spawnSync(["sh", "-c", scenario.setup], { cwd: workDir })

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
if (scenario.isolatedConfig) {
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_SECURESTORAGE_CONFIG_DIR") delete env[key]
  }
  env.CLAUDE_CONFIG_DIR = join(root, "config")
  await mkdir(env.CLAUDE_CONFIG_DIR)
}

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
    `--permission-mode=${scenario.permissionMode ?? "default"}`,
    ...(scenario.model === null ? [] : [`--model=${scenario.model ?? "haiku"}`]),
    ...(scenario.args ?? []),
  ],
  { cwd: workDir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
)
const stderr = new Response(proc.stderr).text()

const started = performance.now()
const elapsed = () => Math.round(performance.now() - started)
const messages: Message[] = []
const sendLine = (line: string) => {
  messages.push({ _sent: JSON.parse(line), _ms: elapsed() })
  proc.stdin.write(line + "\n")
}
const send = (message: Message) => sendLine(JSON.stringify(message))
const closeStdin = () => {
  messages.push({ _stdin_closed: true, _ms: elapsed() })
  void proc.stdin.end()
}
const pendingControls = new Set<string>()
const controlSubtypes = new Map<string, string>()
const waiters: { match: (message: Message) => boolean; resolve: () => void }[] = []
const waitFor = (match: (message: Message) => boolean) =>
  new Promise<void>((resolve) => waiters.push({ match, resolve }))
let ended = false

const sendControl = (id: string, request: Message) => {
  controlSubtypes.set(id, request.subtype)
  send({ type: "control_request", request_id: id, request })
}

const primitives = (value: Message | undefined) =>
  value && Object.fromEntries(Object.entries(value).filter(([, inner]) => inner === null || typeof inner !== "object"))

// get_settings holds permission rules and env, so only these fields may reach disk or the terminal.
const cutSettings = (response: Message) => ({
  keys: Object.keys(response),
  applied: primitives(response.applied),
  sources: response.sources?.map(({ source, settings }: Message) => ({
    source,
    enabledPlugins: settings?.enabledPlugins,
    skillOverrides: settings?.skillOverrides,
    model: settings?.model,
    effortLevel: settings?.effortLevel,
    modelSettings: settings?.modelSettings,
    ultracode: settings?.ultracode,
  })),
})

// Only what the plugin probe needs: initialize also carries the account, hooks carry their commands.
const cutInitialize = (response: Message) => ({
  keys: Object.keys(response),
  commands: response.commands,
  agents: response.agents,
  output_style: response.output_style,
  models: response.models,
  current_permission_mode: response.current_permission_mode,
  capabilities: response.capabilities,
  session_state: response.session_state,
  fast_mode_state: response.fast_mode_state,
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

const timeout = setTimeout(() => proc.kill(), scenario.timeoutMs ?? 180_000)
const decoder = new TextDecoder()
let buffer = ""
let sawNotification = false

const runSteps = async (steps: Step[]) => {
  for (const [index, step] of steps.entries()) {
    if (ended) break
    if ("control" in step) {
      const id = `probe-step-${index}`
      const answered = waitFor((message) => message.type === "control_response" && message.response?.request_id === id)
      sendControl(id, typeof step.control === "function" ? step.control(messages) : step.control)
      await answered
    } else if ("send" in step) {
      send(step.send)
    } else if ("until" in step) {
      await waitFor(step.until)
    } else if ("signal" in step) {
      messages.push({ _signal: step.signal, _ms: elapsed() })
      proc.kill(step.signal)
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
const stepsDone = scenario.steps ? runSteps(scenario.steps).finally(closeStdin) : undefined

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

    for (const waiter of waiters.filter(({ match }) => match(message))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }

    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      const answer = (scenario.answer ?? ((request) => allowTool(request.request_id, request.request.input)))(message)
      if (answer) sendLine(answer)
    }
    const sdkTools = message.type === "control_request" && scenario.sdkServers?.[message.request?.server_name]
    if (sdkTools && message.request.subtype === "mcp_message") {
      const { id, method, params } = message.request.message
      const reply =
        id === undefined
          ? mcpAck(message.request_id)
          : mcpResponse(
              message.request_id,
              id,
              method === "initialize"
                ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: message.request.server_name, version: "0" } }
                : method === "tools/list"
                  ? { tools: sdkTools.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { text: { type: "string" } } } })) }
                  : method === "tools/call"
                    ? { content: [{ type: "text", text: `echo: ${params.arguments?.text ?? ""}` }] }
                    : {},
            )
      sendLine(reply)
    }
    if (requestId) pendingControls.delete(requestId)
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

ended = true
for (const { resolve } of waiters) resolve()
await stepsDone
if (!scenario.steps) closeStdin()
const exitCode = await proc.exited
messages.push({ _exit: exitCode, signal: proc.signalCode, _ms: elapsed() })
const stderrText = await stderr
if (stderrText) {
  messages.push({ _stderr: stderrText })
  console.error(stderrText)
}
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

const kindOf = (message: Message): string => {
  const marker = Object.keys(message)[0] ?? ""
  if (marker === "_sent") return `_sent ${kindOf(message._sent)}`
  if (marker.startsWith("_")) return marker
  return [message.type, message.subtype ?? message.event?.type ?? message.request?.subtype].filter(Boolean).join("/")
}

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
