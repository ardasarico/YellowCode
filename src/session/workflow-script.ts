import { z } from "zod"

export type WorkflowPhase = { title: string; detail: string; agents: WorkflowAgentPlan[] }
export type WorkflowAgentPlan = { label: string; prompt: string }
export type WorkflowPlan = { name: string; script: string; phases: WorkflowPhase[]; loose: WorkflowAgentPlan[] }

const workflowInput = z.looseObject({ script: z.string() })

// A quoted or template string literal; the script is never run, so `${…}` stays as written.
const STRING = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\]|\\.)*\`)`

function literal(token: string | undefined): string {
  if (!token) return ""
  return token
    .slice(1, -1)
    .replace(/\\(.)/g, (_, char: string) => (char === "n" || char === "t" ? " " : char))
    .replace(/\s+/g, " ")
    .trim()
}

function field(block: string, key: string): string {
  return literal(new RegExp(String.raw`\b${key}\s*:\s*${STRING}`).exec(block)?.[1])
}

// The object literal after `meta =`, up to its closing brace at the start of a line.
function metaBlock(script: string): string {
  const start = /\bmeta\s*=\s*\{/.exec(script)
  if (!start) return ""
  const end = script.indexOf("\n}", start.index)
  return script.slice(start.index, end < 0 ? undefined : end)
}

// What a Workflow script says it will do, read from its text: `meta`, `phase(…)` calls and `agent(…)` calls with a
// literal prompt. Agents built in loops or from variables are not listed.
export function workflowPlan(input: unknown): WorkflowPlan | null {
  const parsed = workflowInput.safeParse(input)
  if (!parsed.success) return null
  const script = parsed.data.script
  const meta = metaBlock(script)
  const phases: WorkflowPhase[] = [
    ...meta.matchAll(new RegExp(String.raw`\{\s*title\s*:\s*${STRING}(?:\s*,\s*detail\s*:\s*${STRING})?`, "g")),
  ].map((match) => ({ title: literal(match[1]), detail: literal(match[2]), agents: [] }))
  const calls = [...script.matchAll(new RegExp(String.raw`\bphase\(\s*${STRING}`, "g"))].map((match) => ({
    at: match.index,
    title: literal(match[1]),
  }))
  for (const call of calls)
    if (!phases.some((phase) => phase.title === call.title)) phases.push({ title: call.title, detail: "", agents: [] })

  const loose: WorkflowAgentPlan[] = []
  for (const match of script.matchAll(new RegExp(String.raw`\bagent\(\s*${STRING}\s*(?:,\s*\{([^}]*)\})?`, "g"))) {
    const options = match[2] ?? ""
    const agent = { label: field(options, "label"), prompt: literal(match[1]) }
    const title = field(options, "phase") || calls.findLast((call) => call.at < match.index)?.title
    const phase = phases.find((entry) => entry.title === title)
    if (phase) phase.agents.push(agent)
    else loose.push(agent)
  }
  return { name: field(meta, "name"), script, phases, loose }
}
