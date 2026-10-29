import { initialize, text, type Driver } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

export async function startThread(d: Driver, params: Record<string, unknown> = {}): Promise<string> {
  await initialize(d)
  return text(
    await d.request("thread/start", { cwd: d.directory, historyMode: "paginated", ...params }),
    "thread",
    "id",
  )
}

export const prompt = (threadId: string, words: string) => ({
  threadId,
  input: [{ type: "text", text: words, text_elements: [] }],
})

// The smallest turn: initialize, start a thread, send one prompt, wait for it to finish.
export const rawHello: RawScenario = {
  name: "raw-hello",
  script: { threads: [{ match: "HELLO", steps: [[{ type: "text", text: "Hello there." }]] }] },
  async steps(d) {
    const threadId = await startThread(d)
    await d.request("turn/start", prompt(threadId, "HELLO"))
    await d.until("turn/completed")
  },
}
