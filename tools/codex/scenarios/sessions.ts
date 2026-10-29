import { CODEX } from "../../../src/agents/codex/caps.ts"
import type { AgentDriver } from "../agent-driver.ts"
import type { AgentScenario } from "../scenario.ts"

async function turn(a: AgentDriver, prompt: string): Promise<void> {
  const sent = await a.send(prompt)
  if (!sent.ok) throw new Error(sent.problem)
  await a.until("turn.end")
}

const reply = (match: string, text: string) => ({ match, steps: [[{ type: "text" as const, text }]] })

// The adapter starts a thread and runs a turn; its app-server is killed, so the session ends, and a restart goes on
// with the same thread in a new app-server.
export const connect: AgentScenario = {
  name: "connect",
  script: { threads: [reply("ALPHA", "Hello from Codex."), reply("BRAVO", "Still here after the restart.")] },
  async run(a) {
    await a.start()
    await turn(a, "ALPHA say hello")
    a.kill()
    await a.until("ended")
    const again = await a.restart()
    if (!again.ok) throw new Error(again.problem)
    await turn(a, "BRAVO are you back?")
    await a.close()
  },
}

// Two threads with turns and one with none, which the list leaves out; then the history of the first.
export const sessions: AgentScenario = {
  name: "sessions",
  script: {
    threads: [
      reply("ECHO one", "The readme describes a small demo."),
      reply("ECHO two", "There is one source file, src/a.ts."),
      reply("GOLF", "A second thread."),
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "ECHO one: what is in the readme?")
    await turn(a, "ECHO two: and the source?")
    await a.start()
    await turn(a, "GOLF start over")
    await a.start()
    await a.close()
    await a.sessions()
    await a.history(first)
  },
}

// Three turns; the thread is opened again and goes on, then copied before its second prompt, where it goes on too,
// and copied whole.
export const fork: AgentScenario = {
  name: "fork",
  script: {
    threads: [
      reply("FOXTROT one", "One done."),
      reply("FOXTROT two", "Two done."),
      reply("FOXTROT three", "Three done."),
      reply("FOXTROT four", "Four, on the copy."),
    ],
  },
  async run(a) {
    await a.start()
    const first = a.session()
    await turn(a, "FOXTROT one")
    await turn(a, "FOXTROT two")
    const ref = { agent: CODEX, id: first }
    await a.start({ ref, fork: false, at: null })
    await turn(a, "FOXTROT three")
    await a.start({ ref, fork: true, at: "prompt-2" })
    const copy = a.session()
    await turn(a, "FOXTROT four")
    await a.start({ ref, fork: true, at: null })
    await a.close()
    await a.history(copy)
    await a.sessions()
  },
}
