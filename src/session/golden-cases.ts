// The hand-written inputs of golden.test.ts: lines and calls no recording holds.
import { endSession, interruptFailed, openHeldAsk, restartSession, showEarly } from "../agents/claude/translate.ts"
import packageJson from "../../package.json"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { liveProvider } from "../agents/claude/provider.ts"
import { OWN_ASK, type McpMessage } from "../protocol/messages.ts"
import * as outgoing from "../protocol/outgoing.ts"
import { createAskServer } from "../source/ask-server.ts"
import { claudeArgs, type Launch, launchOf, type Spawn } from "../source/claude-args.ts"
import { createControls } from "../source/controls.ts"
import { OWN_ASK_INIT } from "../source/own-ask-tool.ts"
import type { Requests } from "../source/requests.ts"
import { agentMessage } from "./agent-message.ts"
import { createSession, type SessionStore } from "./session.ts"
import { DEFAULT_SETTINGS, type StoredSettings } from "./settings-file.ts"
import {
  controlProblem,
  initSettings,
  modelRef,
  pickEffort,
  pickModel,
  setControlProblem,
  setKnobs,
  setModelChoices,
  settings,
  toggleUltracode,
} from "./settings.ts"

const IMAGES: outgoing.OutgoingImage[] = [
  { mediaType: "image/png", base64: "iVBORw0KGgo=" },
  { mediaType: "image/jpeg", base64: "/9j/4AAQSkZJRg==" },
]
const PAGES = {
  questions: [
    { question: "Storage?", header: "Storage", options: [{ label: "Per project" }, { label: "Global" }] },
    {
      question: "Formats?",
      header: "Formats",
      options: [{ label: "JSON" }, { label: "YAML", description: "Needs a parser" }],
      multiSelect: true,
    },
  ],
}
const MATRIX = {
  matrix: {
    question: "Ready to ship?",
    header: "Checks",
    rows: [{ label: "Tests pass" }, { label: "Docs updated" }],
    scale: ["Yes", "No", "Unsure"],
  },
}
const PAGE_ANSWERS = { "Storage?": "Per project", "Formats?": "JSON, YAML" }
const ASK = { requestId: "ask-1", input: PAGES }
const mcpRequest = (id: number | undefined, method: string, params?: unknown, server = "yellowcode"): McpMessage => ({
  subtype: "mcp_message",
  server_name: server,
  message: { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params },
})
const askCall = (id: number, toolUseId: string, input: unknown, name = "ask") =>
  mcpRequest(id, "tools/call", { name, arguments: input, _meta: { "claudecode/toolUseId": toolUseId } })
const SHELL = outgoing.shellContext("ls src", "index.tsx\nsession\n")

const promptPair = (...args: Parameters<typeof outgoing.promptLines>) => {
  const { sent, shown } = outgoing.promptLines(...args)
  return `${sent}\n${shown}`
}

// Each case is named after the export it covers, then the branch it takes.
export const outgoingCases: Record<string, string> = {
  "userMessage text": outgoing.userMessage("Explain the build"),
  "userMessage uuid": outgoing.userMessage("And the tests", [], "uuid-1"),
  "userMessage images": outgoing.userMessage("What changed? [Image 1] [Image 2]", IMAGES),
  "userMessage images uuid": outgoing.userMessage("[Image 1]", IMAGES.slice(0, 1), "uuid-2"),
  // Each is the line that goes out, then the line the chat shows.
  "promptLines plain": promptPair("Explain the build", [], "uuid-5"),
  "promptLines kept replies": promptPair("Go on", [], "uuid-6", [outgoing.keptReply("All tests pass.")]),
  "promptLines shells": promptPair("What did ls show?", IMAGES.slice(0, 1), "uuid-7", [], [SHELL]),
  "promptLines kept replies and shells": promptPair(
    "Next",
    [],
    "uuid-8",
    [outgoing.keptReply("Build done."), outgoing.keptReply("Lint done.")],
    [SHELL, outgoing.shellContext("true", "")],
  ),
  "promptLines empty text": promptPair("", [], "uuid-9", [outgoing.keptReply("Done.")], [SHELL]),
  keptReply: outgoing.keptReply("The background build finished."),
  "agentMessage plain": agentMessage("task-1", "reviewer", "Check the tests too"),
  "agentMessage name cleaned": agentMessage("task-2", ' the "lint"\n\t agent ', "Line one\nLine two"),
  shellContext: SHELL,
  "shellContext no output": outgoing.shellContext("true", ""),
  TOOL_DECLINED: outgoing.TOOL_DECLINED,
  DECLINED_WITH_NOTE: outgoing.DECLINED_WITH_NOTE,
  QUESTION_TO_CHAT: outgoing.QUESTION_TO_CHAT,
  NOT_SHOWN: outgoing.NOT_SHOWN,
  SUBAGENT_ASK: outgoing.SUBAGENT_ASK,
  errorResponse: outgoing.errorResponse("req-1", "YellowCode does not support elicitation"),
  allowTool: outgoing.allowTool("req-2", { command: "ls" }),
  "allowTool updatedPermissions": outgoing.allowTool("req-3", { command: "bun test" }, [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "bun test:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ]),
  "allowTool setMode": outgoing.allowTool("req-4", { file_path: "notes.md" }, [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]),
  denyTool: outgoing.denyTool("req-5", outgoing.TOOL_DECLINED),
  "denyTool note": outgoing.denyTool("req-6", `${outgoing.DECLINED_WITH_NOTE}use rg instead`),
  answerQuestions: outgoing.answerQuestions("req-7", PAGES, PAGE_ANSWERS, {}),
  "answerQuestions notes": outgoing.answerQuestions("req-8", PAGES, PAGE_ANSWERS, {
    "Storage?": "keep it local",
    "Formats?": "",
  }),
  "answerQuestions additional note": outgoing.answerQuestions("req-9", PAGES, PAGE_ANSWERS, {}, "ship it soon"),
  "answerQuestions additional note joins last note": outgoing.answerQuestions(
    "req-10",
    PAGES,
    PAGE_ANSWERS,
    { "Formats?": "JSON first" },
    "ship it soon",
  ),
  "answerQuestions additional note without questions": outgoing.answerQuestions(
    "req-11",
    { questions: [] },
    {},
    {},
    "x",
  ),
  "allowAnswers matrix": outgoing.allowAnswers("req-12", MATRIX, { "Tests pass": "Yes", "Docs updated": "No" }, {}),
  "allowAnswers matrix notes": outgoing.allowAnswers(
    "req-13",
    MATRIX,
    { "Tests pass": "Yes", "Docs updated": "Unsure" },
    { "Docs updated": "README only" },
  ),
  mcpResponse: outgoing.mcpResponse("req-14", 3, { content: [{ type: "text", text: "ok" }] }),
  "mcpResponse string id": outgoing.mcpResponse("req-15", "rpc-1", { tools: [] }),
  mcpError: outgoing.mcpError("req-16", 4, -32601, "Method not found"),
  mcpAck: outgoing.mcpAck("req-17"),
  mcpToolError: outgoing.mcpToolError("req-18", 5, "Not shown"),
  "ownAskReply pages": outgoing.ownAskReply(
    ASK,
    6,
    outgoing.answerQuestions("ask-1", PAGES, PAGE_ANSWERS, { "Storage?": "keep it local" }, "ship it soon"),
  ),
  "ownAskReply pages unanswered": outgoing.ownAskReply(
    ASK,
    7,
    outgoing.answerQuestions("ask-1", PAGES, { "Storage?": "Global" }, {}),
  ),
  "ownAskReply matrix": outgoing.ownAskReply(
    { requestId: "ask-2", input: MATRIX },
    "rpc-2",
    outgoing.allowAnswers("ask-2", MATRIX, { "Tests pass": "Yes", "Docs updated": "Unsure" }, { "Docs updated": "x" }),
  ),
  "ownAskReply declined": outgoing.ownAskReply(ASK, 8, outgoing.denyTool("ask-1", outgoing.TOOL_DECLINED)),
  "ownAskReply declined note": outgoing.ownAskReply(
    ASK,
    9,
    outgoing.denyTool("ask-1", `${outgoing.DECLINED_WITH_NOTE}not now`),
  ),
  "ownAskReply to chat": outgoing.ownAskReply(ASK, 10, outgoing.denyTool("ask-1", outgoing.QUESTION_TO_CHAT)),
  "ownAskReply unreadable reply": outgoing.ownAskReply(ASK, 11, outgoing.errorResponse("ask-1", "gone")),
  getContextUsageRequest: outgoing.getContextUsageRequest("req-19"),
  getUsageRequest: outgoing.getUsageRequest("req-20"),
  reloadSkillsRequest: outgoing.reloadSkillsRequest("req-21"),
  mcpSetServersRequest: outgoing.mcpSetServersRequest("req-22", {
    docs: { type: "stdio", command: "docs-server", args: ["--stdio"] },
  }),
  "mcpSetServersRequest none": outgoing.mcpSetServersRequest("req-23", {}),
  interruptRequest: outgoing.interruptRequest("req-24"),
  initializeRequest: outgoing.initializeRequest("req-25"),
  "initializeRequest live": outgoing.initializeRequest("req-26", { perTaskStopAffordance: true, ...OWN_ASK_INIT }),
  getTaskOutputRequest: outgoing.getTaskOutputRequest("req-27", "task-1"),
  stopTaskRequest: outgoing.stopTaskRequest("req-28", "task-2"),
  backgroundTasksRequest: outgoing.backgroundTasksRequest("req-29"),
  rewindConversationRequest: outgoing.rewindConversationRequest("req-30", "uuid-3"),
  renameSession: outgoing.renameSession("req-31", "Build notes"),
  "renameSession sessionId": outgoing.renameSession("req-32", "Build notes", "session-1"),
  getSettingsRequest: outgoing.getSettingsRequest("req-33"),
  ...Object.fromEntries(
    ["default", "auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].map((mode) => [
      `setPermissionModeRequest ${mode}`,
      outgoing.setPermissionModeRequest(`mode-${mode}`, mode),
    ]),
  ),
  setModelRequest: outgoing.setModelRequest("req-34", "opus"),
  "setModelRequest default": outgoing.setModelRequest("req-35", "default"),
  "applyFlagSettingsRequest effort": outgoing.applyFlagSettingsRequest("req-36", {
    effortLevel: "high",
    ultracode: false,
  }),
  "applyFlagSettingsRequest ultracode": outgoing.applyFlagSettingsRequest("req-37", { ultracode: true }),
  "thinkingDisplayRequest summarized": outgoing.thinkingDisplayRequest("req-38", "summarized"),
  "thinkingDisplayRequest omitted": outgoing.thinkingDisplayRequest("req-39", "omitted"),
  fileSuggestionsRequest: outgoing.fileSuggestionsRequest("req-40", "src/ses"),
  getHooksListingRequest: outgoing.getHooksListingRequest("req-41"),
  getSkillsDialogRequest: outgoing.getSkillsDialogRequest("req-42"),
  mcpStatusRequest: outgoing.mcpStatusRequest("req-43"),
  mcpReconnectRequest: outgoing.mcpReconnectRequest("req-44", "docs"),
  "mcpToggleRequest on": outgoing.mcpToggleRequest("req-45", "docs", true),
  "mcpToggleRequest off": outgoing.mcpToggleRequest("req-46", "docs", false),
  reloadPluginsRequest: outgoing.reloadPluginsRequest("req-47"),
}

const summarized = { thinking: "summarized" } as const
const argsCases: Record<string, [Pick<Parameters<typeof claudeArgs>[0], "thinking">, Launch, Spawn?]> = {
  ...Object.fromEntries(
    CLAUDE_MODES.map(({ id, label }) => [`mode ${label}`, [summarized, launchOf({ permissionMode: id })]]),
  ),
  "restart plan, saved auto": [summarized, launchOf({ permissionMode: "auto" }, "plan")],
  "restart plan, saved bypassPermissions": [summarized, launchOf({ permissionMode: "bypassPermissions" }, "plan")],
  "restart bypassPermissions, saved auto": [summarized, launchOf({ permissionMode: "auto" }, "bypassPermissions")],
  "bypassPermissions without the allow flag": [summarized, { mode: "bypassPermissions", bypass: false }],
  "manual with the allow flag": [summarized, { mode: "default", bypass: true }],
  "thinking hidden": [{ thinking: "hidden" }, launchOf({ permissionMode: "auto" })],
  "fresh with session id": [summarized, launchOf({ permissionMode: "auto" }), { sessionId: "session-new" }],
  resume: [summarized, launchOf({ permissionMode: "auto" }), { resume: "session-old" }],
  "resume at": [summarized, launchOf({ permissionMode: "auto" }), { resume: "session-old", at: "uuid-4" }],
  "at without resume": [summarized, launchOf({ permissionMode: "auto" }), { at: "uuid-4" }],
  "fork with session id": [
    summarized,
    launchOf({ permissionMode: "auto" }),
    { resume: "session-old", fork: true, sessionId: "session-new" },
  ],
  "fork at, hidden thinking, plan": [
    { thinking: "hidden" },
    launchOf({ permissionMode: "plan" }),
    { resume: "session-old", at: "uuid-4", fork: true, sessionId: "session-new" },
  ],
}

export const spawnArgs = () =>
  Object.fromEntries(
    Object.entries(argsCases).map(([name, [stored, launch, spawn]]) => [name, claudeArgs(stored, launch, spawn)]),
  )

// What the own ask server sends, and which calls it opens, for each request in turn.
export function askServerLines(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  let emitted: unknown[] = []
  const version = `"version":"${packageJson.version}"`
  const server = createAskServer(
    (line) => emitted.push(line.replace(version, '"version":"<version>"')),
    (toolUseId) => emitted.push(`open ${toolUseId}`),
  )
  const line = (toolUseId: string, parent: string | null) =>
    server.seen({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: `msg-${toolUseId}`, content: [{ type: "tool_use", id: toolUseId, name: OWN_ASK, input: PAGES }] },
    })
  const step = (name: string, run: () => void) => {
    emitted = []
    run()
    out[name] = emitted
  }
  step("initialize", () => server.serve("req-1", mcpRequest(1, "initialize", { protocolVersion: "2025-06-18" })))
  step("initialize without a version", () => server.serve("req-2", mcpRequest(2, "initialize", {})))
  step("ping", () => server.serve("req-3", mcpRequest(3, "ping")))
  step("tools/list", () => server.serve("req-4", mcpRequest(4, "tools/list")))
  step("notification", () => server.serve("req-5", mcpRequest(undefined, "notifications/initialized")))
  step("unknown method", () => server.serve("req-6", mcpRequest(6, "resources/list")))
  step("unknown tool", () => server.serve("req-7", askCall(7, "toolu-x", PAGES, "other")))
  step("invalid input", () => server.serve("req-8", askCall(8, "toolu-bad", { questions: [], matrix: MATRIX.matrix })))
  step("main call after its line", () => {
    line("toolu-main", null)
    server.serve("req-9", askCall(9, "toolu-main", PAGES))
  })
  step("subagent call after its line", () => {
    line("toolu-sub", "toolu-agent")
    server.serve("req-10", askCall(10, "toolu-sub", PAGES))
  })
  step("main call before its line", () => {
    server.serve("req-11", askCall(11, "toolu-late", PAGES))
    line("toolu-late", null)
  })
  step("subagent call before its line", () => {
    server.serve("req-12", askCall(12, "toolu-late-sub", MATRIX))
    line("toolu-late-sub", "toolu-agent")
  })
  step("another server", () => server.serve("req-13", mcpRequest(13, "tools/list", undefined, "docs")))
  server.close()
  return out
}

// The control requests that each change of the knobs sends, and the notice it leaves.
export function controlLines(): Record<string, { lines: string[]; problem: string | null }> {
  const out: Record<string, { lines: string[]; problem: string | null }> = {}
  let lines: string[] = []
  let count = 0
  const requests: Requests = {
    send: (build) => {
      lines.push(build(`ctl-${++count}`))
      return new Promise(() => {})
    },
    settle: () => {},
    close: () => {},
  }
  const before = { ...settings }
  // initSettings, unlike the Config tab, saves nothing to disk.
  let saved = DEFAULT_SETTINGS
  const save = (change: Partial<StoredSettings>) => initSettings((saved = { ...saved, ...change }))
  initSettings(saved)
  setKnobs({ model: null, effort: null, ultracode: false })
  setControlProblem(null)
  const controls = createControls({
    requests,
    provider: liveProvider(() => Promise.resolve([])),
    session: createSession(),
    launch: { mode: "default", bypass: false },
  })
  const step = (name: string, run: () => void) => {
    lines = []
    setControlProblem(null)
    run()
    controls.flush()
    out[name] = { lines, problem: controlProblem()?.text ?? null }
  }
  try {
    step("initialize", () =>
      controls.initialized({
        commands: [],
        models: [
          { value: "default", resolvedModel: "claude-opus-5-5" },
          { value: "opus", resolvedModel: "claude-opus-5-5" },
          { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
        ],
        current_permission_mode: "default",
      }),
    )
    const model = (id: string) => {
      pickModel(id)
      controls.setModel(modelRef(id).id)
    }
    const effort = (level: "max" | "low") => {
      pickEffort(level)
      controls.setEffort(level, settings.ultracode)
    }
    step("model with an alias", () => model("claude-sonnet-5-5"))
    step("model without an alias", () => model("claude-fable-5-1"))
    step("effort", () => effort("max"))
    step("ultracode on", () => controls.setUltracode(toggleUltracode()))
    step("effort with ultracode on", () => effort("low"))
    step("ultracode off", () => controls.setUltracode(toggleUltracode()))
    step("session mode manual", () => controls.setMode("default"))
    step("session mode plan", () => controls.setMode("plan"))
    step("saved mode acceptEdits", () => {
      save({ agents: { claude: { defaultMode: "acceptEdits" } } })
      controls.setMode("acceptEdits")
    })
    step("saved mode bypassPermissions without the allow flag", () => {
      save({ agents: { claude: { defaultMode: "bypassPermissions" } } })
      controls.setMode("bypassPermissions")
    })
    step("thinking hidden", () => {
      save({ thinking: "hidden" })
      controls.setThinking(false)
    })
    step("thinking summarized", () => {
      save({ thinking: "summarized" })
      controls.setThinking(true)
    })
    step("carry all", () => controls.carry({ model: "claude-opus-5-5", effort: "high", ultracode: true }))
    step("carry ultracode only", () => controls.carry({ model: null, effort: null, ultracode: true }))
    step("carry nothing", () => controls.carry({ model: null, effort: null, ultracode: false }))
  } finally {
    controls.dispose()
    setModelChoices([])
    setControlProblem(null)
    const { model, effort, ultracode, ...stored } = before
    initSettings(stored)
    setKnobs({ model, effort, ultracode })
  }
  return out
}

export type Step = { dir: "in" | "out"; line: string } | { call: string; run: (session: SessionStore) => void }

const recv = (message: object): Step => ({ dir: "in", line: JSON.stringify(message) })
const sent = (line: string | object): Step => ({
  dir: "out",
  line: typeof line === "string" ? line : JSON.stringify(line),
})
const call = (name: string, run: (session: SessionStore) => void): Step => ({ call: name, run })

const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-opus-5-5",
  permissionMode: "default",
  cwd: "/Users/user/project",
  claude_code_version: "2.1.312",
  tools: ["Agent", "Bash", "SendMessage", OWN_ASK],
  mcp_servers: [{ name: "yellowcode", status: "connected" }],
  skills: [],
})
const requesting = (uuids?: string[]) => ({
  type: "system",
  subtype: "status",
  status: "requesting",
  ...(uuids ? { user_message_uuids: uuids } : {}),
})
const reply = (id: string, content: object[], extra: object = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, model: "claude-opus-5-5", content, usage: { input_tokens: 120 } },
  ...extra,
})
const text = (value: string) => ({ type: "text", text: value })
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input })
const toolResult = (id: string, content: string, block: object = {}, extra: object = {}) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...block }] },
  ...extra,
})
const result = (extra: object = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.01,
  duration_ms: 1200,
  usage: { input_tokens: 120, output_tokens: 30 },
  ...extra,
})
const taskStarted = (taskId: string, toolUseId: string, prompt: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description: "Review the parser",
  task_type: "local_agent",
  is_backgrounded: true,
  prompt,
})
const taskDone = (taskId: string, toolUseId: string, summary: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: toolUseId,
  status: "completed",
  summary,
})
const ownAskCall = (requestId: string, rpcId: number, toolUseId: string, input: unknown) => ({
  type: "control_request",
  request_id: requestId,
  request: askCall(rpcId, toolUseId, input),
})
const permissionAsk = (requestId: string, toolUseId: string, request: object) => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: toolUseId, ...request },
})

const lastUser = (session: SessionStore) =>
  session.state.items.findLast((id) => session.state.byId[id]?.kind === "user") ?? ""

// Branches of the session no recording reaches, and the calls the app makes on it.
export function scriptedSessions(): Record<string, { steps: Step[]; emitted: unknown[] }> {
  const emitted: unknown[] = []
  let shell = ""
  const protocol: Step[] = [
    recv(init("session-1")),
    sent(outgoing.userMessage(`Check the tree\n\n${SHELL}`)),
    recv(requesting()),
    recv({ type: "system", subtype: "session_title_changed", title: "Tree check" }),
    recv({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1_800_003_600,
        rateLimitType: "seven_day_opus",
        utilization: 0.92,
        unifiedWindows: {
          five_hour: { utilization: 0.5, resetsAt: 1_800_001_800 },
          seven_day: { utilization: 0.8, resetsAt: 1_800_600_000 },
        },
      },
    }),
    recv(reply("msg-1", [toolUse("toolu-1", "Bash", { command: "ls" })])),
    recv(
      toolResult(
        "toolu-1",
        "The user doesn't want to proceed with this tool use.",
        { is_error: true },
        { tool_result_meta: [{ id: "toolu-1", non_execution_kind: "user-rejected" }] },
      ),
    ),
    recv(
      permissionAsk("req-perm-1", "toolu-2", {
        input: { command: "rm -rf build" },
        permission_suggestions: [
          { type: "setMode", mode: "auto", destination: "session" },
          { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow" },
        ],
      }),
    ),
    recv({ type: "control_cancel_request", request_id: "req-perm-1" }),
    recv(
      permissionAsk("req-perm-2", "toolu-3", {
        input: { command: "git push --force" },
        suppress_always_allow_rule: true,
        default_to_no: true,
        decision_reason: "\u001b[1mForce push\u001b[0m",
        decision_reason_type: "safetyCheck",
      }),
    ),
    sent(outgoing.denyTool("req-perm-2", `${outgoing.DECLINED_WITH_NOTE}not now`)),
    recv(
      reply("msg-2", [text("Not logged in · Please run /login")], {
        is_api_error_message: true,
        error: "authentication_failed",
      }),
    ),
    recv(result({ is_error: true, result: "Not logged in · Please run /login" })),
    sent(outgoing.userMessage("/compact")),
    ...[1, 2].map(() =>
      recv({
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "local-1",
        message: { id: "msg-3", model: "<synthetic>", content: [text("Error during compaction: API refused")] },
        local_command_outcome: { kind: "failed" },
      }),
    ),
    recv(result({ local_command: "/compact", is_error: true, result: "API refused" })),
    sent(outgoing.userMessage("/compact")),
    recv({ type: "system", subtype: "status", status: "compacting" }),
    recv({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 50_000, post_tokens: 3000 },
    }),
    recv(result({ local_command: "/compact" })),
    sent(outgoing.userMessage("First", [], "uuid-a")),
    recv(requesting(["uuid-a"])),
    sent(outgoing.userMessage("Second", [], "uuid-b")),
    recv({ type: "command_lifecycle", command_uuid: "uuid-b", state: "queued" }),
    recv({ type: "command_lifecycle", command_uuid: "uuid-b", state: "started" }),
    recv(reply("msg-4", [text("Done with both.")])),
    recv(result({ user_message_uuids: ["uuid-a"] })),
    ...["req-x", "req-y"].map((id) =>
      sent({ type: "control_response", response: { subtype: "success", request_id: id, response: "not an object" } }),
    ),
    recv(permissionAsk("req-q", "toolu-q", { tool_name: "AskUserQuestion", input: PAGES })),
    sent(outgoing.allowTool("req-q", { ...PAGES, answers: "not a record" })),
  ]

  // A /clear keeps a queued message, an open ask and a running agent.
  const reset: Step[] = [
    recv(init("session-2")),
    sent(outgoing.userMessage("Start the build")),
    recv(requesting()),
    recv(reply("msg-1", [toolUse("toolu-r1", "Agent", { description: "Build", name: "builder", prompt: "Build" })])),
    recv(taskStarted("task-r1", "toolu-r1", "Build")),
    recv(toolResult("toolu-r1", "Async agent launched successfully.", {}, { tool_use_result: { isAsync: true } })),
    recv(permissionAsk("req-r1", "toolu-r2", { input: { command: "make" } })),
    recv(reply("msg-2", [text("Waiting for the build.")])),
    recv(result()),
    sent(outgoing.userMessage("/clear")),
    sent(outgoing.userMessage("After the clear", [], "uuid-r1")),
    recv({ type: "system", subtype: "session_title_changed", title: "Build" }),
    recv({ type: "conversation_reset" }),
    recv(init("session-3")),
    recv(result({ local_command: "/clear" })),
  ]

  const ownAsk: Step[] = [
    recv(init("session-3")),
    sent(outgoing.userMessage("Pick the storage")),
    recv(requesting()),
    recv(reply("msg-1", [toolUse("toolu-a1", OWN_ASK, PAGES)])),
    recv(ownAskCall("req-a1", 1, "toolu-a1", PAGES)),
    sent(
      outgoing.ownAskReply(
        { requestId: "req-a1", input: PAGES },
        1,
        outgoing.denyTool("req-a1", `${outgoing.DECLINED_WITH_NOTE}not now`),
      ),
    ),
    recv(reply("msg-2", [toolUse("toolu-a2", OWN_ASK, MATRIX)])),
    recv(ownAskCall("req-a2", 2, "toolu-a2", MATRIX)),
    sent(
      outgoing.ownAskReply(
        { requestId: "req-a2", input: MATRIX },
        2,
        outgoing.allowAnswers("req-a2", MATRIX, { "Tests pass": "Yes", "Docs updated": "No" }, { "Tests pass": "ok" }),
      ),
    ),
    recv(ownAskCall("req-a3", 3, "toolu-a3", PAGES)),
    call('openHeldAsk("toolu-a3")', (session) => openHeldAsk(session, "toolu-a3")),
    recv({
      type: "control_request",
      request_id: "req-c",
      request: mcpRequest(undefined, "notifications/cancelled", { requestId: 3 }),
    }),
    recv(ownAskCall("req-a4", 4, "toolu-a4", PAGES)),
    sent(outgoing.mcpToolError("req-a4", 4, outgoing.SUBAGENT_ASK)),
    call('openHeldAsk("toolu-a4")', (session) => openHeldAsk(session, "toolu-a4")),
    recv({
      type: "control_request",
      request_id: "req-m",
      request: mcpRequest(5, "tools/call", { name: "search" }, "docs"),
    }),
    recv(result()),
  ]

  const message = agentMessage("task-g1", 'the "reviewer"\n agent', "Check the tests too")
  const agents: Step[] = [
    recv(init("session-4")),
    sent(outgoing.userMessage("Review the parser")),
    recv(requesting()),
    recv(
      reply("msg-1", [
        toolUse("toolu-g1", "Agent", {
          description: "Review the parser",
          name: "reviewer",
          subagent_type: "general-purpose",
          prompt: "Review src/parser.ts",
        }),
      ]),
    ),
    recv(taskStarted("task-g1", "toolu-g1", "Review src/parser.ts")),
    recv({
      type: "assistant",
      parent_tool_use_id: "toolu-g1",
      message: { id: "msg-sub", content: [toolUse("toolu-e1", "Edit", { file_path: "src/parser.ts" })] },
    }),
    recv({
      ...toolResult("toolu-e1", "Updated."),
      parent_tool_use_id: "toolu-g1",
      tool_use_result: { originalFile: "a" },
    }),
    recv(reply("msg-w", [toolUse("toolu-w1", "Write", { file_path: "notes.md", content: "Notes" })])),
    recv(
      toolResult(
        "toolu-w1",
        "File created successfully at: notes.md",
        {},
        {
          tool_use_result: { type: "create", originalFile: null },
        },
      ),
    ),
    recv(reply("msg-e", [toolUse("toolu-e2", "Edit", { file_path: "notes.md" })])),
    recv(toolResult("toolu-e2", "Updated.", {}, { tool_use_result: { originalFile: "Notes" } })),
    recv(
      toolResult(
        "toolu-g1",
        "Async agent launched successfully.\nagentId: task-g1",
        {},
        {
          tool_use_result: { isAsync: true, agentId: "task-g1" },
        },
      ),
    ),
    recv(result()),
    recv(taskDone("task-g1", "toolu-g1", "No problems found.")),
    recv(requesting()),
    recv(reply("msg-2", [text("The reviewer found no problems.")])),
    recv(result()),
    sent(outgoing.userMessage(message, [], "uuid-m1")),
    recv(requesting(["uuid-m1"])),
    recv(reply("msg-3", [toolUse("toolu-s1", "SendMessage", { to: "task-g1", message: "Check the tests too" })])),
    recv(taskStarted("task-g1", "toolu-s1", "Check the tests too")),
    recv(toolResult("toolu-s1", '{"success":true,"message":"Resuming agent task-g1"}')),
    recv(reply("msg-4", [text("Passed it on.")])),
    recv(result()),
    sent(outgoing.stopTaskRequest("req-stop", "task-g1")),
    recv({ ...taskDone("task-g1", "toolu-s1", "Stopped."), status: "stopped", stopped_by_user: true }),
  ]

  const hidden = (session: SessionStore) => session.hideTurnsOf(["task-h1"], () => emitted.push("hidden turn started"))
  const store: Step[] = [
    recv(init("session-5")),
    call("showEarly", (session) => showEarly(session, outgoing.promptLines("Plan the release", [], "uuid-1").shown)),
    sent(outgoing.promptLines("Plan the release", [], "uuid-1").sent),
    recv(requesting(["uuid-1"])),
    call("showEarly while running", (session) => showEarly(session, outgoing.userMessage("And notes", [], "uuid-2"))),
    call('notSent("uuid-2")', (session) => session.notSent("uuid-2")),
    recv(reply("msg-1", [text("Here is the plan.")])),
    recv(result({ user_message_uuids: ["uuid-1"] })),
    call('startShell("ls src")', (session) => (shell = session.startShell("ls src", false))),
    call("shellOutput", (session) => session.shellOutput(shell, "index.tsx\n")),
    call("endShell done", (session) => session.endShell(shell, "index.tsx\nsession\n", 0, false)),
    call('startShell("false")', (session) => (shell = session.startShell("false", false))),
    call("endShell failed", (session) => session.endShell(shell, "failed", 1, false)),
    call('startShell("sleep 10")', (session) => (shell = session.startShell("sleep 10", true))),
    call("endShell stopped", (session) => session.endShell(shell, "", null, true)),
    call("showEarly with shells", (session) =>
      showEarly(session, outgoing.promptLines("What did ls show?", [], "uuid-3", [], [SHELL]).shown),
    ),
    sent(outgoing.promptLines("What did ls show?", [], "uuid-3", [], [SHELL]).sent),
    recv(requesting(["uuid-3"])),
    recv(reply("msg-2", [text("It shows **two")])),
    call("interrupting", (session) => session.interrupting()),
    call("interruptFailed", interruptFailed),
    sent(outgoing.interruptRequest("req-int")),
    recv(result({ subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] stopped"] })),
    recv({ type: "control_response", response: { subtype: "success", request_id: "req-int" } }),
    call('setPermissionMode("plan")', (session) => session.setPermissionMode("plan")),
    call("setLists", (session) => session.setLists({ mcpServers: [], plugins: [] })),
    call("rewind", (session) => session.rewind({ userId: lastUser(session), prompts: 1, files: [], keptFiles: false })),
    call("redo", (session) => session.redo()),
    call("rewind again", (session) =>
      session.rewind({ userId: lastUser(session), prompts: 1, files: [], keptFiles: true }),
    ),
    sent(outgoing.userMessage("Start over", [], "uuid-4")),
    recv(requesting(["uuid-4"])),
    recv(reply("msg-3", [toolUse("toolu-h1", "Agent", { description: "Build", name: "builder", prompt: "Build" })])),
    recv(taskStarted("task-h1", "toolu-h1", "Build")),
    recv(toolResult("toolu-h1", "Async agent launched successfully.", {}, { tool_use_result: { isAsync: true } })),
    recv(result({ user_message_uuids: ["uuid-4"] })),
    call('hideTurnsOf(["task-h1"])', hidden),
    recv(taskDone("task-h1", "toolu-h1", "Built.")),
    recv(init("session-5")),
    recv(requesting()),
    recv(reply("msg-4", [text("The build finished.")])),
    recv(result()),
    call("restart", restartSession),
    recv(init("session-5")),
    sent(outgoing.userMessage("Continue", [], "uuid-5")),
    recv(requesting(["uuid-5"])),
    sent(outgoing.userMessage("One more", [], "uuid-6")),
    recv({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "msg-5" } },
    }),
    recv({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Working" } },
    }),
    call("end with a problem", (session) =>
      endSession(session, { text: "Claude Code stopped", detail: ["exit code 1"] }),
    ),
  ]

  return {
    protocol: { steps: protocol, emitted: [] },
    reset: { steps: reset, emitted: [] },
    "own-ask": { steps: ownAsk, emitted: [] },
    agents: { steps: agents, emitted: [] },
    store: { steps: store, emitted },
  }
}
