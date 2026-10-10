import { expect, test } from "bun:test"
import { join } from "node:path"
import { createSession, type SessionStore } from "../session/session.ts"
import { listSessions } from "./session-list.ts"
import { loadTranscript, readTranscript } from "./transcript.ts"

const FOLDER = join(import.meta.dir, "..", "..", "fixtures", "transcripts", "-Users-user-project")

async function pathOf(title: string): Promise<string> {
  const entry = (await listSessions(FOLDER, "/Users/user/project")).find((session) => session.title === title)
  if (!entry) throw new Error(`no fixture session titled ${title}`)
  return entry.path
}

async function open(title: string): Promise<SessionStore> {
  const session = createSession()
  loadTranscript(session, await readTranscript(await pathOf(title)))
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

test("compact: the boundary shows as a divider and the summary stays hidden", async () => {
  expect(rows(await open("Reply with the word alpha."))).toEqual([
    "user Reply with the word alpha.",
    "user Reply with the word beta.",
    "system context compacted",
    "user /compact",
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
  loadTranscript(session, last)
  expect(rows(session)).toEqual(prompts(6, 25))
  expect(last.earlier).not.toBeNull()

  const earlier = await readTranscript(path, last.earlier ?? undefined)
  expect(earlier.earlier).toBeNull()
  const part = createSession()
  loadTranscript(part, earlier)
  expect(rows(part)).toEqual(prompts(1, 5))

  session.prepend(earlier.events)
  expect(rows(session)).toEqual(prompts(1, 25))
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
    tool_use_result: { isAsync: true },
  }),
]

test("work with no recorded outcome shows as stopped, in the first part and in earlier ones", () => {
  const session = createSession()
  loadTranscript(session, { events: unfinished("a"), earlier: null })
  session.prepend(unfinished("b"))
  const tools = Object.values(session.state.byId).flatMap((item) => (item.kind === "tool" ? [item] : []))
  expect(tools.map((tool) => [tool.name, tool.status, tool.agent?.state ?? null])).toEqual([
    ["Bash", "stopped", null],
    ["Agent", "done", "stopped"],
    ["Bash", "stopped", null],
    ["Agent", "done", "stopped"],
  ])
})
