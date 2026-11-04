import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession, loadHistory, type SessionStore } from "../../session/session.ts"
import { parse } from "../../protocol/parse.ts"
import { activeNodes } from "../../ui/agents/tree.ts"
import { listSessions } from "./session-list.ts"
import { readTranscript } from "./transcript.ts"
import { feed, translateLines } from "./translate.ts"

const FOLDER = join(import.meta.dir, "..", "..", "..", "fixtures", "transcripts", "-Users-user-project")

async function pathOf(title: string): Promise<string> {
  const entry = (await listSessions(FOLDER, "/Users/user/project")).find((session) => session.title === title)
  if (!entry) throw new Error(`no fixture session titled ${title}`)
  return entry.path
}

async function open(title: string): Promise<SessionStore> {
  const session = createSession()
  loadHistory(session, (await readTranscript(await pathOf(title))).events)
  return session
}

function rows(session: SessionStore): string[] {
  return session.state.items.flatMap((id) => {
    const item = session.state.byId[id]
    if (item?.kind === "user") return [`user ${item.text}`]
    if (item?.kind === "system") return [`system ${item.text}`]
    return []
  })
}

const prompts = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => `user Reply with the number ${from + k}.`)

test("branch: only the branch the leaf hangs on is loaded", async () => {
  expect(rows(await open("Reply with the word red."))).toEqual([
    "user Reply with the word red.",
    "user Reply with the word blue.",
  ])
})

test("compact: the divider follows the /compact prompt and the summary stays hidden", async () => {
  expect(rows(await open("Reply with the word alpha."))).toEqual([
    "user Reply with the word alpha.",
    "user Reply with the word beta.",
    "user /compact",
    "system context compacted",
    "user Reply with the word gamma.",
  ])
})

test("tools: a trailing sidechain entry is not the leaf", async () => {
  const session = await open("Read notes.txt and reply with its first word.")
  expect(rows(session)).toEqual(["user Read notes.txt and reply with its first word."])
  const tool = Object.values(session.state.byId).find((item) => item.kind === "tool")
  expect(tool).toMatchObject({ status: "done" })
})

test("long: earlier parts load from the cursor and go in front", async () => {
  const path = await pathOf("Reply with the number 1.")
  const session = createSession()
  const last = await readTranscript(path)
  loadHistory(session, last.events)
  expect(rows(session)).toEqual(prompts(6, 25))
  expect(last.earlier).not.toBeNull()

  const earlier = await readTranscript(path, last.earlier ?? undefined)
  expect(earlier.earlier).toBeNull()
  const part = createSession()
  loadHistory(part, earlier.events)
  expect(rows(part)).toEqual(prompts(1, 5))

  session.prepend(earlier.events)
  expect(rows(session)).toEqual(prompts(1, 25))
})

const user = (content: string, extra: object = {}) => ({ type: "user", message: { role: "user", content }, ...extra })
const command = (name: string, args = "") =>
  user(
    `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
  )
const stdout = (text: string) => user(`<local-command-stdout>${text}</local-command-stdout>`)
const caveat = user("<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>", {
  isMeta: true,
})

test("a task notification ends its agent and an interrupt ends its turn, and neither is a user row", async () => {
  const path = join(FOLDER, "..", "-Users-user-tasks", "5e55a0b1-7c1d-4e2f-9a3b-6c7d8e9f0a1b.jsonl")
  const session = createSession()
  loadHistory(session, (await readTranscript(path)).events)
  expect(rows(session)).toEqual([
    "user Start a background agent that counts the sheep.",
    "user Write a short poem about rain.",
  ])
  const items = Object.values(session.state.byId)
  expect(items.find((item) => item.kind === "tool")).toMatchObject({ agent: { state: "completed" } })
  expect(items.find((item) => item.kind === "turn-end")).toMatchObject({
    interrupted: true,
    error: null,
    durationMs: 5000,
  })
})

test("a later task notification without its tool-use-id still reaches the agent", async () => {
  const result = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] },
  }
  const note = (summary: string, toolUseId: string | null) =>
    user(
      `<task-notification>\n<task-id>afake0</task-id>\n${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ""}` +
        `<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    )
  const entries = [
    user("count the sheep"),
    {
      type: "assistant",
      message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] },
    },
    result,
    note("waiting on its own work", "t1"),
    note("finished", null),
  ]
  const lines = entries.map((entry, index) =>
    JSON.stringify({ ...entry, uuid: `u${index}`, parentUuid: index === 0 ? null : `u${index - 1}` }),
  )
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-transcript-")), "notes.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  const session = createSession()
  loadHistory(session, (await readTranscript(path)).events)
  const tool = Object.values(session.state.byId).find((item) => item.kind === "tool")
  expect(tool).toMatchObject({ agent: { state: "completed", report: "finished" } })
})

test("commands claude ran itself drop out with their output, /compact stays", async () => {
  const entries = [
    user("first"),
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "one" }] } },
    caveat,
    command("model", "haiku"),
    stdout("Set model to haiku"),
    caveat,
    command("context"),
    { type: "system", subtype: "local_command", content: "<local-command-stdout>Context</local-command-stdout>" },
    caveat,
    command("compact"),
    stdout("Compacted "),
    user("second"),
  ]
  const lines = entries.map((entry, index) =>
    JSON.stringify({ ...entry, uuid: `u${index}`, parentUuid: index === 0 ? null : `u${index - 1}` }),
  )
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-transcript-")), "commands.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  const session = createSession()
  loadHistory(session, (await readTranscript(path)).events)
  expect(rows(session)).toEqual(["user first", "user /compact", "user second"])
})

const line = (message: object) => ({ dir: "in" as const, line: JSON.stringify(message), at: 0 })

// A Bash call with no result and a background Agent whose outcome never came.
const unfinished = (prefix: string) => [
  line({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: `${prefix}m`,
      content: [
        { type: "tool_use", id: `${prefix}bash`, name: "Bash", input: { command: "sleep 9" } },
        { type: "tool_use", id: `${prefix}agent`, name: "Agent", input: { description: "look around" } },
      ],
    },
  }),
  line({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${prefix}agent`, content: "launched" }] },
    tool_use_result: { isAsync: true, agentId: `${prefix}task` },
  }),
]

test("work with no recorded outcome shows as stopped, in the first part and in earlier ones", () => {
  const session = createSession()
  loadHistory(session, translateLines(unfinished("a")))
  session.prepend(translateLines(unfinished("b")))
  const tools = Object.values(session.state.byId).flatMap((item) => (item.kind === "tool" ? [item] : []))
  expect(tools.map((tool) => [tool.name, tool.status, tool.agent?.state ?? null])).toEqual([
    ["Bash", "stopped", null],
    ["Agent", "done", "stopped"],
    ["Bash", "stopped", null],
    ["Agent", "done", "stopped"],
  ])
})

test("a resumed session keeps the agents it left running in the panel, stopped; earlier parts add none", () => {
  const session = createSession({ starting: true })
  session.prepend(translateLines(unfinished("a")))
  session.prepend(translateLines(unfinished("b")))
  const left = session.state.unfinished
  expect(left).toHaveLength(1)
  expect(left[0]).toBe("aagent")
  expect(activeNodes(session.state).find((node) => node.id === left[0])?.state).toBe("stopped")
})

test("an agent left unfinished and woken by a message runs in the message's row, its lines with it", () => {
  const session = createSession({ starting: true })
  session.prepend(translateLines(unfinished("a")))
  const live = [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "tool_use", id: "send", name: "SendMessage", input: { to: "atask" } }] },
    },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "atask", task_type: "local_agent" }] },
    { type: "system", subtype: "task_started", task_id: "atask", tool_use_id: "send", task_type: "local_agent" },
    {
      type: "assistant",
      parent_tool_use_id: "aagent",
      message: { id: "m2", content: [{ type: "tool_use", id: "inner", name: "Bash", input: { command: "true" } }] },
    },
  ]
  for (const message of live) feed(session, "in", parse(JSON.stringify(message)), 0)
  const send = session.state.byId["send"]
  expect(send?.kind === "tool" && [send.agent?.state, send.children]).toEqual(["running", ["inner"]])
  expect(session.state.unfinished).toEqual([])
  expect(activeNodes(session.state).find((node) => node.id === "send")?.state).toBe("running")
})

const agentCall = (id: string) => ({
  type: "assistant",
  message: {
    id: `m${id}`,
    role: "assistant",
    content: [{ type: "tool_use", id: `t${id}`, name: "Agent", input: {} }],
  },
})

test("a killed note marks its agent as stopped by the user, a stopped one does not", async () => {
  const note = (status: string, id: string) =>
    user(
      `<task-notification>\n<task-id>a${id}</task-id>\n<tool-use-id>t${id}</tool-use-id>\n` +
        `<status>${status}</status>\n<summary>s</summary>\n</task-notification>`,
    )
  const entries = [user("go"), agentCall("1"), agentCall("2"), note("killed", "1"), note("stopped", "2")]
  const lines = entries.map((entry, index) =>
    JSON.stringify({ ...entry, uuid: `u${index}`, parentUuid: index === 0 ? null : `u${index - 1}` }),
  )
  const path = join(mkdtempSync(join(tmpdir(), "yellowcode-transcript-")), "killed.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  const session = createSession()
  loadHistory(session, (await readTranscript(path)).events)
  expect(session.state.byId.t1).toMatchObject({ agent: { state: "stopped", stoppedByUser: true } })
  expect(session.state.byId.t2).toMatchObject({ agent: { state: "stopped", stoppedByUser: false } })
})
