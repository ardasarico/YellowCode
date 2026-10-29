// One answer from opencode for YellowCode's session titles: its stateless generation on the default model, which no
// session or history holds.
import { z } from "zod"
import { log } from "../../log/log.ts"
import type { Transport } from "./transport.ts"
import { answerOf, dataOf } from "./wire/envelope.ts"

const TITLE_MS = 30_000
const generated = dataOf(z.looseObject({ text: z.string() }))

export async function answerOnce(transport: Transport, prompt: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TITLE_MS)))
  const sent = transport
    .request({ method: "POST", path: "/api/experimental/generate/text", body: { prompt } })
    .catch(() => null)
  const reply = await Promise.race([sent, late])
  clearTimeout(timer)
  const answer = reply ? answerOf(reply, generated, "generated text") : null
  if (answer?.kind === "ok") return answer.value.data.text
  log.warn("opencode: session title failed", answer?.kind === "error" ? (answer.message ?? answer.tag) : "no answer")
  return null
}
