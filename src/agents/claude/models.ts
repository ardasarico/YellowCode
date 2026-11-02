// The models claude lists, read from a claude that keeps no session and runs no turn: initialize, then per model
// set_model and get_context_usage for its window. No model request goes out. Customizations stay off, and no SDK MCP
// server is named, so claude starts no hook or server and writes no MCP log.
/* oxlint-disable no-await-in-loop -- one model at a time on one claude */
import { z } from "zod"
import type { ModelGroup, ModelRow } from "../../agent/lists.ts"
import { hostEnv } from "../../source/claude-cli.ts"
import { stdioTransport } from "../codex/transport.ts"
import { modelsOf } from "./lists.ts"

const PROBE_MS = 30_000
const ARGS = [
  "-p",
  "--input-format=stream-json",
  "--output-format=stream-json",
  "--verbose",
  "--safe-mode",
  "--no-session-persistence",
]

const reply = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({ subtype: z.string(), request_id: z.string(), response: z.unknown().optional() }),
})
const request = z.looseObject({ type: z.literal("control_request"), request_id: z.string() })
const initialized = z.looseObject({ models: z.array(z.unknown()) })
const usage = z.looseObject({ maxTokens: z.number().int().positive() })

export async function listModels(cwd: string): Promise<ModelGroup[]> {
  const claude = stdioTransport({ command: ["claude", ...ARGS], cwd, env: hostEnv(), name: "claude" })
  const waiting = new Map<string, (answer: { ok: boolean; response: unknown } | null) => void>()
  void (async () => {
    for await (const raw of claude.messages) {
      const answer = reply.safeParse(raw)
      if (answer.success) {
        const { request_id: id, subtype, response } = answer.data.response
        waiting.get(id)?.({ ok: subtype === "success", response })
        waiting.delete(id)
        continue
      }
      // Nothing is served here; an answer keeps claude from waiting on it.
      const asked = request.safeParse(raw)
      if (asked.success)
        claude.send({
          type: "control_response",
          response: { subtype: "error", request_id: asked.data.request_id, error: "not served" },
        })
    }
    for (const done of waiting.values()) done(null)
    waiting.clear()
  })()
  let next = 0
  const ask = (subtype: string, fields: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `models-${++next}`
      waiting.set(id, (answer) =>
        answer?.ok ? resolve(answer.response) : reject(new Error(`claude did not answer ${subtype}`)),
      )
      try {
        claude.send({ type: "control_request", request_id: id, request: { subtype, ...fields } })
      } catch (error) {
        waiting.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  const timer = setTimeout(() => void claude.close(), PROBE_MS)
  try {
    const listed = initialized.safeParse(await ask("initialize"))
    if (!listed.success) throw new Error("claude listed no models")
    const models: ModelRow[] = []
    for (const row of modelsOf(listed.data.models)) {
      const window = await ask("set_model", { model: row.ref.id })
        .then(() => ask("get_context_usage"))
        .then(
          (answer) => usage.safeParse(answer).data?.maxTokens ?? null,
          () => null,
        )
      models.push({ ...row, window })
    }
    return [{ provider: null, applies: "now", models }]
  } finally {
    clearTimeout(timer)
    await claude.close()
  }
}
