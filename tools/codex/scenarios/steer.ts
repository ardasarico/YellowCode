import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Outcome } from "../../../src/agent/ids.ts"
import { initialize, pick, text } from "../driver.ts"
import type { Root } from "../env.ts"
import type { AgentScenario } from "../scenario.ts"
import { AGENTS, spawned } from "./tools.ts"
import { turn } from "./turns.ts"

const say = (words: string) => [{ type: "text" as const, text: words }]
const exec = (cmd: string, yieldMs = 10_000) => ({
  type: "call" as const,
  name: "exec_command",
  arguments: { cmd, yield_time_ms: yieldMs },
})

async function done(outcome: Promise<Outcome>): Promise<void> {
  const got = await outcome
  if (!got.ok) throw new Error(got.problem)
}

// Each request the mock got, as the texts of its input in order: user words, the model's words and tool outputs.
async function requests(root: Root): Promise<string[][]> {
  const lines = (await readFile(join(root.root, "bodies.jsonl"), "utf8")).trim().split("\n")
  return lines.map((line) => {
    const input = pick(JSON.parse(line), "input")
    return Array.isArray(input) ? input.map((entry) => JSON.stringify(entry)) : []
  })
}

// The request that holds `words` last, as one string per input entry.
async function lastWith(root: Root, words: string): Promise<string[]> {
  const found = (await requests(root)).findLast((input) => input.some((entry) => entry.includes(words)))
  if (!found) throw new Error(`the mock got no request with ${words}`)
  return found
}

function expect(what: string, ok: boolean): void {
  if (!ok) throw new Error(`the mock did not get ${what}`)
}

// Enter during a turn steers the prompt into it: Codex hands it to the model after the command's output.
export const steer: AgentScenario = {
  name: "steer",
  script: {
    threads: [{ match: "OSCAR", steps: [[exec("sleep 1; echo slept")], say("Slept, and noted the weather.")] }],
  },
  async run(a) {
    await a.start(null, { mode: "full-access" })
    await done(a.send("OSCAR run a slow command"))
    await a.until("tool.start")
    await done(a.send("also mention the weather"))
    await a.until("user.taken")
    await a.until("turn.end")
    await a.close()
  },
  async verify(root) {
    const input = await lastWith(root, "also mention the weather")
    const output = input.findIndex((entry) => entry.includes("function_call_output"))
    const steered = input.findIndex((entry) => entry.includes("also mention the weather"))
    expect("the steered text after the command's output", output >= 0 && steered > output)
  },
}

// A queued prompt waits in the thread's queue and runs as a turn of its own once the turn ends.
export const queued: AgentScenario = {
  name: "queue",
  script: {
    threads: [
      { match: "ROMEO", steps: [[exec("sleep 1; echo slept")], say("Romeo done.")] },
      { match: "SIERRA", steps: [say("Sierra, after Romeo.")] },
    ],
  },
  async run(a) {
    await a.start(null, { mode: "full-access" })
    await done(a.send("ROMEO run a slow command"))
    await a.until("tool.start")
    await done(a.send("SIERRA when you are done", [], "queue"))
    await a.until("turn.end")
    await a.until("user.taken")
    await a.until("turn.end")
    await a.close()
  },
}

// An interrupt stops the turn while its command runs. The prompt steered into it was not taken yet; it runs next.
export const interrupt: AgentScenario = {
  name: "interrupt",
  script: {
    threads: [
      { match: "TANGO", steps: [[exec("sleep 5; echo slept")], say("Tango done.")] },
      { match: "UNIFORM", steps: [say("Uniform, after the stop.")] },
    ],
  },
  async run(a) {
    await a.start(null, { mode: "full-access" })
    await done(a.send("TANGO run a long command"))
    await a.until("tool.start")
    await done(a.send("UNIFORM after the stop"))
    await done(a.interrupt())
    await a.until("turn.end", (event) => event.interrupted)
    await a.until("user.taken")
    await a.until("turn.end")
    await a.close()
  },
  async verify(root) {
    const input = await lastWith(root, "UNIFORM after the stop")
    expect("the steered prompt as a turn of its own", input.at(-1)?.includes("UNIFORM after the stop") === true)
  },
}

// A cut taken back changes nothing; the next one goes in with the send, and the model no longer hears the cut turn.
export const cut: AgentScenario = {
  name: "cut",
  script: {
    threads: [
      { match: "VICTOR one", steps: [say("One.")] },
      { match: "VICTOR two", steps: [say("Two.")] },
      { match: "VICTOR three", steps: [say("Three, after one.")] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "VICTOR one")
    await turn(a, "VICTOR two")
    await done(a.cut("prompt-1"))
    await done(a.undoCut())
    await done(a.cut("prompt-2"))
    await turn(a, "VICTOR three")
    await a.close()
    // Codex lists a reverted thread twice; /resume shows it once.
    await a.sessions()
  },
  async verify(root) {
    const input = (await lastWith(root, "VICTOR three")).join("\n")
    expect("one turn kept and the cut one left out", input.includes("VICTOR one") && !input.includes("VICTOR two"))
  },
}

// A thread an older Codex made keeps legacy history, which Codex cannot revert: the cut goes on in a copy made before
// the turn, and the thread itself stays as it was.
export const cutLegacy: AgentScenario = {
  name: "cut-legacy",
  script: {
    threads: [
      { match: "WHISKEY one", steps: [say("One.")] },
      { match: "WHISKEY two", steps: [say("Two.")] },
      { match: "WHISKEY three", steps: [say("Three, in the copy.")] },
    ],
  },
  async run(a) {
    const legacy = await a.prepare(async (d) => {
      await initialize(d)
      const thread = text(await d.request("thread/start", { cwd: d.directory, historyMode: "legacy" }), "thread", "id")
      for (const [n, words] of [
        [1, "WHISKEY one"],
        [2, "WHISKEY two"],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one turn after the other
        await d.request("turn/start", {
          threadId: thread,
          input: [{ type: "text", text: words, text_elements: [] }],
          clientUserMessageId: `legacy-${n}`,
        })
        // oxlint-disable-next-line no-await-in-loop -- one turn after the other
        await d.until("turn/completed")
      }
      return thread
    })
    await a.start({ ref: { agent: "codex", id: legacy }, fork: false, at: null })
    await done(a.cut("legacy-2"))
    await done(a.goBack("legacy-2"))
    if (a.session() === legacy) throw new Error("the session did not move to the copy")
    await turn(a, "WHISKEY three")
    await a.close()
    await a.sessions()
  },
  async verify(root) {
    const input = (await lastWith(root, "WHISKEY three")).join("\n")
    expect("one turn kept and the cut one left out", input.includes("WHISKEY one") && !input.includes("WHISKEY two"))
  },
}

// Another client cuts the thread back before the second turn; the chat hears where the cut starts.
export const cutElsewhere: AgentScenario = {
  name: "cut-elsewhere",
  script: {
    threads: [
      { match: "XRAY one", steps: [say("One.")] },
      { match: "XRAY two", steps: [say("Two.")] },
      { match: "XRAY three", steps: [say("Three, after one.")] },
    ],
  },
  async run(a) {
    await a.start()
    await turn(a, "XRAY one")
    await turn(a, "XRAY two")
    const threadId = a.session()
    const newest = pick(await a.raw("thread/turns/list", { threadId, limit: 1 }), "data", 0, "id")
    await a.raw("thread/revert", { threadId, beforeTurnId: newest })
    await a.until("cut")
    await turn(a, "XRAY three")
    await a.close()
  },
  async verify(root) {
    const input = (await lastWith(root, "XRAY three")).join("\n")
    expect("one turn kept and the cut one left out", input.includes("XRAY one") && !input.includes("XRAY two"))
  },
}

// A command still running when its turn ends goes on as a background shell, which the user stops.
export const bgShell: AgentScenario = {
  name: "bg-shell",
  script: { threads: [{ match: "YANKEE", steps: [[exec("sleep 30", 300)], say("Left it running.")] }] },
  async run(a) {
    await a.start(null, { mode: "full-access" })
    await done(a.send("YANKEE start a server"))
    const task = await a.until("task.start")
    await a.until("turn.end")
    await done(a.stopTask(task.id))
    await a.until("task.end")
    await a.close()
  },
}

// The user stops a subagent while it runs a command; the main agent's wait ends and it goes on. The wait is short:
// Codex sometimes waits it out for a subagent that was stopped.
export const stopAgent: AgentScenario = {
  name: "stop-agent",
  script: {
    threads: [
      {
        match: "ZULU",
        steps: [
          [{ type: "search", query: "spawn agent" }],
          [{ type: "call", namespace: AGENTS, name: "spawn_agent", arguments: { message: "HOTEL sleep a while" } }],
          [
            {
              type: "call",
              namespace: AGENTS,
              name: "wait_agent",
              arguments: (input) => ({ targets: [spawned(input)], timeout_ms: 10000 }),
            },
          ],
          say("The helper was stopped."),
        ],
      },
      { match: "HOTEL", steps: [[exec("sleep 20")], say("Woke up.")] },
    ],
  },
  async run(a) {
    await a.start(null, { mode: "full-access" })
    await done(a.send("ZULU have a helper sleep"))
    const task = await a.until("task.start")
    await a.until("tool.start", (event) => event.parent !== null && event.kind === "shell")
    await done(a.stopTask(task.id))
    await a.until("task.end")
    await a.until("turn.end")
    await a.close()
  },
}
