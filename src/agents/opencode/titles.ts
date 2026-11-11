// One answer from opencode for YellowCode's session titles: its stateless generation, which no session or history
// holds.
import { z } from "zod"
import { log } from "../../log/log.ts"
import type { Transport } from "./transport.ts"
import { answerOf, dataOf } from "./wire/envelope.ts"

const TITLE_MS = 30_000
const generated = dataOf(z.looseObject({ text: z.string() }))

type Model = { providerID: string; id: string }

async function generate(
  transport: Transport,
  prompt: string,
  model: Model | null,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))
  const body = model ? { prompt, model: { providerID: model.providerID, id: model.id } } : { prompt }
  const sent = transport.request({ method: "POST", path: "/api/experimental/generate/text", body }).catch(() => null)
  const reply = await Promise.race([sent, late])
  clearTimeout(timer)
  const answer = reply ? answerOf(reply, generated, "generated text") : null
  if (answer?.kind === "ok") return answer.value.data.text
  log.warn(
    `opencode: one-shot failed on ${model ? `${model.providerID}/${model.id}` : "the default model"}`,
    answer?.kind === "error" ? (answer.message ?? answer.tag) : "no answer",
  )
  return null
}

// The session's own model first, which the user can run; opencode's default model, which may be off or out of
// credit, only when that fails.
export async function answerOnce(
  transport: Transport,
  prompt: string,
  model: Model | null,
  timeoutMs = TITLE_MS,
): Promise<string | null> {
  if (model) {
    const text = await generate(transport, prompt, model, timeoutMs)
    if (text !== null) return text
  }
  return generate(transport, prompt, null, timeoutMs)
}
