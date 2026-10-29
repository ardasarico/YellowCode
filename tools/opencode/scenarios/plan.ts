import type { Block } from "../mock.ts"
import type { AgentScenario } from "../scenario.ts"

const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool" as const, name, input })
const say = (text: string): Block[] => [{ type: "text", text }]

// The first step waits, so the title, which opencode asks for alongside it, is always counted first.
const waited = (blocks: Block[]) => ({ blocks, waitMs: 300 })

// The plan agent writes in <HOME>/.opencode/plan; the isolated home sits beside the project.
export const PLAN_FILE = "../home/.opencode/plan/report-json.md"
export const PLAN_TEXT =
  "# Report as JSON\n\n1. Add a --json flag to report.ts\n2. Print the summary as JSON\n3. Add one test\n"
// What the file holds once the turn's edit ran.
export const PLAN_DONE = PLAN_TEXT.replace("one test", "two tests")

// In plan mode the agent writes a plan file and edits it, so the turn ends with the plan. Starting on it switches to
// build and sends the start message, which a later thread answers in build.
export const planFile: AgentScenario = {
  name: "plan-file",
  script: {
    title: "Plan a JSON report",
    threads: [
      {
        match: "UNIFORM",
        steps: [
          waited([...say("Writing the plan."), tool("write", { path: PLAN_FILE, content: PLAN_TEXT })]),
          [tool("edit", { path: PLAN_FILE, oldString: "one test", newString: "two tests" })],
          say("The plan is ready."),
        ],
      },
      // The longer match wins once both prompts are in the request; the plan turn made three steps.
      { match: "Implement the plan.", steps: [[], [], [], say("Implementing it now.")] },
    ],
  },
  async run(a) {
    await a.start()
    await a.until("mode")
    await a.setMode("plan")
    await a.until("mode", (event) => event.mode === "plan")
    await a.send("UNIFORM plan a --json flag for the report")
    await a.until("turn.end", undefined, 60_000)
    const plan = await a.until("plan")
    await a.setMode(plan.next ?? "build")
    await a.until("mode", (event) => event.mode === plan.next)
    await a.send("Implement the plan.")
    await a.until("turn.end", undefined, 60_000)
    await a.close()
  },
}

// In plan mode the agent reads, has an edit outside the plan folder turned down, and asks a question in its reply:
// no plan file, so no plan. Back in build, a file written in the plan folder is no plan either.
export const planQuestion: AgentScenario = {
  name: "plan-question",
  script: {
    title: "Plan questions",
    threads: [
      {
        match: "VICTOR",
        steps: [
          waited([...say("Looking first."), tool("read", { path: "src/a.ts" })]),
          [tool("edit", { path: "src/a.ts", oldString: '"hello"', newString: '"hi"' })],
          say("Should the JSON include the log lines, or only the versions?"),
        ],
      },
      {
        match: "WHISKEY note it in the plan folder",
        steps: [[], [], [], [tool("write", { path: PLAN_FILE, content: "Notes\n" })], say("Noted.")],
      },
    ],
  },
  async run(a) {
    await a.start()
    await a.until("mode")
    await a.setMode("plan")
    await a.until("mode", (event) => event.mode === "plan")
    await a.send("VICTOR plan a --json flag for the report")
    await a.until("turn.end", undefined, 60_000)
    await a.setMode("build")
    await a.until("mode", (event) => event.mode === "build")
    await a.send("WHISKEY note it in the plan folder")
    await a.until("turn.end", undefined, 60_000)
    await a.close()
  },
}
