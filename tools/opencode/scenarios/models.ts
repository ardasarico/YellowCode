import { OPENCODE } from "../../../src/agents/opencode/caps.ts"
import { MOCK_KEY } from "../../../src/agents/opencode/fixture.ts"
import type { AgentDriver } from "../agent-driver.ts"
import { HAIKU, model } from "../env.ts"
import type { AgentScenario } from "../scenario.ts"

export const LAB = "claude-lab-1"

async function turn(a: AgentDriver, prompt: string): Promise<void> {
  await a.send(prompt)
  await a.until("turn.end")
}

async function refused(done: Promise<{ ok: boolean }>, what: string): Promise<void> {
  if ((await done).ok) throw new Error(`opencode took ${what}`)
}

// A second provider with a model of its own, beside anthropic. Each answer names the model and effort its request
// asked for. The session switches effort, then model within the provider and then provider (the effort goes along),
// then back to the default effort. A level or model opencode did not list is refused before anything goes out.
// Opened again, the session says the model it runs, and runs it.
export const models: AgentScenario = {
  name: "models",
  config: (mock) => ({
    enabled_providers: ["anthropic", "lab"],
    providers: {
      lab: {
        name: "Second Lab",
        canonical: "anthropic",
        settings: { apiKey: MOCK_KEY, baseURL: mock },
        models: { [LAB]: model("Lab One") },
      },
    },
  }),
  script: {
    title: "Switching models",
    echo: true,
    threads: [
      {
        match: "MIKE",
        steps: [
          [{ type: "text", text: "One." }],
          [{ type: "text", text: "Two." }],
          [{ type: "text", text: "Three." }],
          [{ type: "text", text: "Four." }],
          [{ type: "text", text: "Five." }],
          [{ type: "text", text: "Six." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    a.refresh("models")
    await a.until("lists", (event) => event.lists.models !== undefined)
    await a.until("effort")
    await turn(a, "MIKE one")
    await a.setEffort("high")
    await turn(a, "MIKE two")
    await a.setModel({ provider: "anthropic", id: HAIKU })
    await turn(a, "MIKE three")
    await a.setModel({ provider: "lab", id: LAB })
    await turn(a, "MIKE four")
    await a.setEffort("default")
    await refused(a.setEffort("ultra"), "an effort the model lacks")
    await refused(a.setModel({ provider: "lab", id: HAIKU }), "a model the provider lacks")
    await turn(a, "MIKE five")
    const first = a.session()
    await a.start({ ref: { agent: OPENCODE, id: first }, fork: false, at: null })
    await a.until("model")
    a.refresh("models")
    await a.until("lists", (event) => event.lists.models !== undefined)
    await turn(a, "MIKE six")
    await a.close()
  },
}

export const PLAIN = "plain-1"

// The build agent runs haiku of its own and plan runs the default. Without a pick of its own the session runs its
// mode's model, which is told on each switch, and an effort picked goes out with it. A model without levels has no
// effort, and refuses one.
export const agentModel: AgentScenario = {
  name: "agent-model",
  config: (mock) => ({
    enabled_providers: ["anthropic", "plain"],
    agents: { title: { model: `anthropic/${HAIKU}` }, build: { model: `anthropic/${HAIKU}` } },
    providers: {
      plain: {
        name: "Plain",
        canonical: "anthropic",
        settings: { apiKey: MOCK_KEY, baseURL: mock },
        models: { [PLAIN]: { ...model("Plain One"), capabilities: { reasoning: { supported: false } } } },
      },
    },
  }),
  script: {
    title: "An agent's own model",
    echo: true,
    threads: [
      {
        match: "OSCAR",
        steps: [
          [{ type: "text", text: "One." }],
          [{ type: "text", text: "Two." }],
          [{ type: "text", text: "Three." }],
          [{ type: "text", text: "Four." }],
        ],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.until("mode")
    a.refresh("models")
    await a.until("lists", (event) => event.lists.models !== undefined)
    await a.until("effort")
    await turn(a, "OSCAR one")
    await a.setMode("plan")
    await a.until("mode", (event) => event.mode === "plan")
    await turn(a, "OSCAR two")
    await a.setMode("build")
    await a.until("mode", (event) => event.mode === "build")
    await a.setEffort("high")
    await turn(a, "OSCAR three")
    await a.setModel({ provider: "plain", id: PLAIN })
    await refused(a.setEffort("high"), "an effort for a model without levels")
    await turn(a, "OSCAR four")
    await a.close()
  },
}
