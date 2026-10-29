import { OPENCODE } from "../../../src/agents/opencode/caps.ts"
import { messageOf } from "../../../src/agents/opencode/prompts.ts"
import { text } from "../driver.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

async function turn(a: AgentDriver, prompt: string): Promise<void> {
  await a.send(prompt)
  await a.until("turn.end")
}

const prompts = (page: { events: { type: string; prompt?: string | null }[] }) =>
  page.events.flatMap((event) => (event.type === "user" && event.prompt ? [event.prompt] : []))

// Three turns in one session, the last one staged for a revert; then four more sessions over raw http that the list
// must leave out but one: an untitled one, an archived one, one in another folder and a subagent's child. The list
// is read, the unfiltered list too, and the history before and after the stage.
export const sessions: AgentScenario = {
  name: "sessions",
  script: {
    title: "Reading the readme",
    threads: [
      {
        match: "ECHO",
        steps: [
          [
            { type: "thinking", thinking: "The readme is short, so read it whole." },
            { type: "text", text: "Let me read it." },
            { type: "tool", name: "read", input: { path: "README.md" } },
          ],
          [{ type: "text", text: "It describes a small demo project." }],
          [{ type: "text", text: "There is one source file, src/a.ts." }],
          [{ type: "text", text: "That is all there is." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "ECHO what is in the readme")
    await turn(a, "ECHO and the source?")
    await turn(a, "ECHO anything else?")
    const third = prompts(await a.history(first))[2]
    if (!third) throw new Error("the history has no third prompt")
    await a.http("POST", `/api/session/${first}/revert/stage`, { messageID: messageOf(third), files: false })
    const project = { location: { directory: a.directory } }
    const make = async (body: unknown) => text(await a.http("POST", "/api/session", body), "body", "data", "id")
    await make(project)
    const archived = await make(project)
    await a.http("PATCH", `/api/session/${archived}`, { archived: true })
    await make({ location: { directory: a.directory.replace(/project$/, "home") } })
    await make({ ...project, parentID: first })
    await a.http("GET", "/api/session")
    await a.sessions()
    await a.history(first)
    await a.close()
  },
}

// Two turns; the session is opened again, reconnects (so a resync reads what it stored) and goes on, then it is
// copied before its second prompt and goes on there.
export const fork: AgentScenario = {
  name: "fork",
  script: {
    title: "Counting turns",
    threads: [
      {
        match: "FOXTROT",
        steps: [
          [{ type: "text", text: "One done." }],
          [{ type: "text", text: "Two done." }],
          [{ type: "text", text: "Three done." }],
        ],
      },
      { match: "FOXTROT four", steps: [[], [{ type: "text", text: "Four, on the copy." }]] },
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "FOXTROT one")
    await turn(a, "FOXTROT two")
    const second = prompts(await a.history(first))[1]
    if (!second) throw new Error("the history has no second prompt")
    const ref = { agent: OPENCODE, id: first }
    await a.start({ ref, fork: false, at: null })
    await a.reconnect()
    await turn(a, "FOXTROT three")
    await a.start({ ref, fork: true, at: second })
    const copy = a.session()
    await turn(a, "FOXTROT four")
    await a.history(copy)
    await a.sessions()
    await a.close()
  },
}

// opencode titles the session from its first prompt; the step waits so the title comes before the turn ends. A rename
// replaces it, a later prompt does not title it again, and the list reads the new name.
export const title: AgentScenario = {
  name: "title",
  script: {
    title: "Naming the session",
    threads: [
      {
        match: "INDIA",
        steps: [{ waitMs: 2000, blocks: [{ type: "text", text: "Named." }] }, [{ type: "text", text: "Still named." }]],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.send("INDIA name this session")
    await a.until("title")
    await a.until("turn.end")
    await a.rename("Renamed by hand")
    await a.until("title", (event) => event.title === "Renamed by hand")
    await turn(a, "INDIA once more")
    await a.sessions()
    await a.close()
  },
}
