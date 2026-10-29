import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Root } from "../env.ts"
import type { AgentScenario } from "../scenario.ts"
import { turn } from "./turns.ts"

const requestBody = z.looseObject({
  model: z.string().optional(),
  reasoning: z.looseObject({ effort: z.string().optional(), summary: z.string().optional() }).optional(),
  input: z.array(z.unknown()).optional(),
})
type Body = z.output<typeof requestBody>

const isUser = (entry: unknown) =>
  typeof entry === "object" && entry !== null && "role" in entry && entry.role === "user"

// The requests the mock got whose last user message holds `word`, in order.
async function bodies(root: Root, word: string): Promise<Body[]> {
  const text = await readFile(join(root.root, "bodies.jsonl"), "utf8")
  return text
    .trim()
    .split("\n")
    .map((line) => requestBody.parse(JSON.parse(line)))
    .filter((body) => JSON.stringify(body.input?.findLast(isUser) ?? null).includes(word))
}

function expect(what: string, ok: boolean): void {
  if (!ok) throw new Error(`the mock did not get ${what}`)
}

// The access a request tells the model it runs under, as the last of Codex's permission messages words it.
function accessOf(body: Body | undefined): string {
  const text = JSON.stringify(body?.input ?? [])
  const sandbox = [...text.matchAll(/sandbox_mode` is `([a-z-]+)`/g)].at(-1)?.[1]
  // On request, Codex tells the model how to ask; on never, that it cannot.
  const asks = [...text.matchAll(/How to request escalation|Approval policy is currently never/g)].at(-1)?.[0]
  const approval = asks === undefined ? "unknown" : asks.endsWith("never") ? "never" : "on-request"
  return `${sandbox} ${approval}`
}
const told = (body: Body | undefined, words: string) => JSON.stringify(body?.input ?? []).includes(words)

const say = (text: string) => [{ type: "text" as const, text }]

async function done<T extends { ok: true } | { ok: false; problem: string }>(outcome: Promise<T>): Promise<void> {
  const got = await outcome
  if (!got.ok) throw new Error(got.problem)
}

// A new thread starts in the saved mode, then walks the modes: Default, Plan (the access stays), Full Access (Plan
// ends). A resumed thread is switched to the mode asked for.
export const modes: AgentScenario = {
  name: "modes",
  script: {
    threads: [
      { match: "NOVEMBER one", steps: [say("Read only.")] },
      { match: "NOVEMBER two", steps: [say("Default.")] },
      { match: "NOVEMBER three", steps: [say("Planning.")] },
      { match: "NOVEMBER four", steps: [say("Full access.")] },
    ],
  },
  async run(a) {
    await a.start(null, { defaultMode: "read-only" })
    a.refresh("modes")
    await a.until("lists")
    await turn(a, "NOVEMBER one")
    await done(a.setMode("auto"))
    await a.until("mode")
    await turn(a, "NOVEMBER two")
    await done(a.setMode("plan"))
    await a.until("mode")
    await turn(a, "NOVEMBER three")
    await done(a.setMode("full-access"))
    await a.until("mode")
    await turn(a, "NOVEMBER four")
    const id = a.session()
    await a.start({ ref: { agent: "codex", id }, fork: false, at: null }, { mode: "read-only" })
    await a.until("mode")
    await a.close()
  },
  async verify(root) {
    const [one, two, three, four] = await Promise.all(
      ["NOVEMBER one", "NOVEMBER two", "NOVEMBER three", "NOVEMBER four"].map((word) => bodies(root, word)),
    )
    const got = [one, two, three, four].map((found) => accessOf(found?.[0]))
    const want = ["read-only on-request", "workspace-write on-request", "workspace-write on-request"]
    expect(`the access asked for (${got.join(", ")})`, got.join() === [...want, "danger-full-access never"].join())
    expect("Plan mode's instructions", told(three?.[0], "Plan Mode") && !told(two?.[0], "Plan Mode"))
    expect("Default mode's after Plan", told(four?.[0], "Collaboration Mode: Default"))
  },
}

// The models of the session's provider and of another one; a model and effort switch, thinking on and off, and an
// effort change while a turn runs, which applies from the next turn.
export const models: AgentScenario = {
  name: "models",
  config: '[model_providers.other]\nname = "Other"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n',
  script: {
    threads: [
      { match: "OSCAR one", steps: [say("On gpt-5.6-luna.")] },
      {
        match: "OSCAR two",
        steps: [
          [{ type: "call", name: "exec_command", arguments: { cmd: "sleep 1", yield_time_ms: 3000 } }],
          say("Slept."),
        ],
      },
      { match: "OSCAR three", steps: [say("No summary.")] },
    ],
  },
  async run(a) {
    await a.start()
    a.refresh("models")
    await a.until("lists")
    const other = await a.setModel({ provider: "other", id: "gpt-5.5" })
    if (other.ok) throw new Error("another provider's model applied now")
    await done(a.setModel({ provider: "mock", id: "gpt-5.6-luna" }))
    await a.until("model")
    await done(a.setEffort("high"))
    await a.until("effort")
    await done(a.setThinking(true))
    await turn(a, "OSCAR one")
    const sent = await a.send("OSCAR two")
    if (!sent.ok) throw new Error(sent.problem)
    await a.until("tool.start")
    await done(a.setEffort("low"))
    await a.until("turn.end")
    await done(a.setThinking(false))
    await turn(a, "OSCAR three")
    await a.close()
  },
  async verify(root) {
    const [one, two, three] = await Promise.all(["OSCAR one", "OSCAR two", "OSCAR three"].map((w) => bodies(root, w)))
    const first = one?.[0]
    expect("gpt-5.6-luna at high with a summary", first?.model === "gpt-5.6-luna" && first.reasoning?.effort === "high")
    expect("a summary asked for", first?.reasoning?.summary === "auto")
    // Codex takes a change in a running turn only with its step_model_switching feature, which is off.
    expect("high through the turn the change came in", two?.every((body) => body.reasoning?.effort === "high") === true)
    expect("low after it, with no summary", three?.[0]?.reasoning?.effort === "low" && !three[0].reasoning.summary)
  },
}

const PLAN = "<proposed_plan>\n# Greeting\n\n1. Read src/a.ts\n2. Change the greeting\n</proposed_plan>"

// Plan mode gives a finished plan; "Yes, start" goes on in the access the plan was made in, and sends the start.
export const plan: AgentScenario = {
  name: "plan",
  script: {
    threads: [
      { match: "PAPA", steps: [say(`Here is the plan.\n\n${PLAN}`)] },
      { match: "Implement the plan.", steps: [say("Implemented.")] },
    ],
  },
  async run(a) {
    await a.start()
    await done(a.setMode("plan"))
    await a.until("mode")
    await turn(a, "PAPA change the greeting")
    const finished = await a.until("plan")
    if (finished.next === null) throw new Error("the plan names no mode to go on in")
    await done(a.setMode(finished.next))
    await a.until("mode")
    await turn(a, "Implement the plan.")
    await a.close()
  },
}

const step = (text: string, status: string) => ({ step: text, status })

// With Codex's plan tool on, the model keeps its steps as it works; each update is the whole list.
export const planSteps: AgentScenario = {
  name: "plan-steps",
  config: "[tools.update_plan]\nenabled = true\n",
  script: {
    threads: [
      {
        match: "QUEBEC",
        steps: [
          [
            {
              type: "call",
              name: "update_plan",
              arguments: {
                explanation: "Two steps",
                plan: [step("Read src/a.ts", "in_progress"), step("Change the greeting", "pending")],
              },
            },
          ],
          [
            {
              type: "call",
              name: "update_plan",
              arguments: { plan: [step("Read src/a.ts", "completed"), step("Change the greeting", "completed")] },
            },
          ],
          say("Both steps done."),
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "QUEBEC work in steps")
    await a.close()
  },
}
