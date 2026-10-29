import type { Prompt } from "../agent/agent.ts"
import type { AgentEvent } from "../agent/events.ts"
import { log } from "../log/log.ts"
import type { SessionStore } from "./session.ts"

// Feeds the store from an agent's events until they end. Claude's agent still feeds its store itself and gives none.
export async function follow(events: AsyncIterable<AgentEvent>, store: SessionStore): Promise<void> {
  try {
    for await (const event of events) {
      try {
        store.event(event)
      } catch (error) {
        log.error(`cannot apply ${event.type}`, error)
      }
    }
  } catch (error) {
    log.error("the agent's events failed", error)
    // The message stays in the log: a transport error could name the service's address.
    if (store.state.status !== "ended")
      store.event({ type: "ended", problem: { text: "The agent stopped", detail: [] }, at: Date.now() })
  }
}

// The prompt in the chat at Enter, before it goes out, for an agent that does not show it itself.
export function showEarly(store: SessionStore, prompt: Prompt): void {
  store.showEarly({
    prompt: prompt.id,
    text: prompt.text,
    images: prompt.images.map((image, index) => ({
      name: `Image ${index + 1}`,
      mediaType: image.mediaType,
      data: image.base64,
      path: null,
    })),
    to: prompt.to,
    history: false,
    cutPoint: true,
  })
}
