import type { Agent, Prompt } from "../../agent/agent.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { Outcome } from "../../agent/ids.ts"
import { suggestFiles } from "../../input/files.ts"
import { log } from "../../log/log.ts"
import { userMessage } from "../../protocol/outgoing.ts"
import { agentMessage } from "../../session/agent-message.ts"
import type { SessionStore } from "../../session/session.ts"
import { pump } from "../../source/live.ts"
import type { Recording } from "../../source/recording.ts"
import { createReplaySource, type Speed } from "../../source/replay.ts"
import { CLAUDE, CLAUDE_CAPS } from "./caps.ts"
import { answerAsk } from "./answers.ts"
import { endSession } from "./translate.ts"

// What index.tsx still reaches beyond the neutral Agent of a replay.
export type ClaudeReplay = Agent & {
  // Plays the recording into the store.
  begin(): void
  // False while the recording does not wait for the user, so a message cannot go out.
  accepts(): boolean
  replayStatus(): "playing" | "waiting" | "finished"
}

const ok: Outcome = { ok: true, note: null }
const nothing = (): Promise<Outcome> => Promise.resolve({ ok: false, problem: "A replay plays back what was recorded" })

// The replay's own message takes the recorded one's place; a recording has no lifecycle lines to settle a uuid, so it
// carries none. An empty one releases the recorded message.
const lineOf = (prompt: Prompt) => {
  if (prompt.to === null && !prompt.text.trim() && prompt.images.length === 0) return ""
  return userMessage(prompt.to ? agentMessage(prompt.to.task, prompt.to.name, prompt.text) : prompt.text, prompt.images)
}

// A Claude recording played into the store; `send` and `answer` release the next recorded message or reply.
export function claudeReplay(recording: Recording, speed: Speed, store: SessionStore): ClaudeReplay {
  const source = createReplaySource(recording, speed)
  const closed = Promise.withResolvers<void>()
  return {
    kind: CLAUDE,
    get session() {
      return { agent: CLAUDE, id: store.state.info?.id ?? "" }
    },
    get version() {
      return store.state.info?.cliVersion ?? ""
    },
    // No task of a recording runs, so none can be sent to the background.
    caps: { ...CLAUDE_CAPS, backgroundNow: false },
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => closed.promise.then((): IteratorResult<AgentEvent> => ({ done: true, value: undefined })),
      }),
    },
    begin() {
      void pump(source, store, null).then(() => endSession(store))
    },
    accepts: source.waiting,
    replayStatus: source.status,
    send: (prompt) =>
      Promise.resolve(
        source.send(lineOf(prompt)) ? ok : { ok: false, problem: "The replay does not wait for a message" },
      ),
    answer(id, reply) {
      const ask = store.state.byId[`ask-${id}`]
      if (ask?.kind !== "ask") {
        log.warn("answer to an unknown ask", { requestId: id })
        return Promise.resolve()
      }
      return answerAsk(store, ask, reply, (line) => source.send(line))
    },
    interrupt: nothing,
    restart: nothing,
    close() {
      source.close()
      closed.resolve()
      return Promise.resolve()
    },
    setMode: nothing,
    setModel: nothing,
    setEffort: nothing,
    setExtraEffort: nothing,
    setThinking: nothing,
    rename: nothing,
    cut: nothing,
    undoCut: nothing,
    refresh: () => {},
    tasks: { stop: nothing, background: nothing },
    mcp: { toggle: nothing, reconnect: nothing, login: nothing },
    skills: { toggle: nothing, reload: nothing },
    plugins: { toggle: nothing, reload: nothing },
    permissions: { remove: nothing },
    settings: { rows: () => Promise.resolve([]), write: nothing },
    context: () => Promise.reject(new Error("a replay has no context report")),
    usage: () => Promise.reject(new Error("a replay has no usage report")),
    files: suggestFiles,
    setClientTools: nothing,
    setMcpServers: nothing,
  }
}
