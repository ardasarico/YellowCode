// Prompts that go out while a turn runs: steered into it (Codex takes them at its next model request), or queued in
// the thread for after it. Each is told taken when its user message comes, or dropped when Codex lets it go. A prompt
// steered into a turn the user interrupted runs next, as on Claude: Codex drops it, so it goes to the thread's queue,
// which an interrupt leaves paused until it is started again.
import type { Prompt } from "../../agent/agent.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { PromptId } from "../../agent/ids.ts"
import { log } from "../../log/log.ts"
import { RpcError, type Rpc } from "./transport.ts"
import { queueDeleted, queuePage, resultOf } from "./wire/thread.ts"

type Waiting = {
  input: unknown[]
  via: "start" | "steer" | "queue"
  // A started prompt that may come in a turn other than its own, so the chat shows it waiting.
  late: boolean
  // It left Codex's queue.
  left: boolean
}

// app-server's words when the turn a steer names is not the one that runs, or none runs.
const OTHER_TURN = /but found `([^`]+)`/
const NO_TURN = /no active turn/

export type Delivery = {
  // Rejects with Codex's words when the prompt did not go out.
  send(prompt: Prompt, input: unknown[], summary: string): Promise<void>
  // What the translator told; a prompt of ours that waited is taken.
  told(events: AgentEvent[]): AgentEvent[]
  queueChanged(): Promise<void>
  // Only a prompt in the thread's queue comes back; one steered into the turn is Codex's already.
  withdraw(prompt: PromptId): Promise<boolean>
  // The main thread's turn ended; `ours`: our interrupt ended it.
  turnEnded(ours: boolean, at: number): Promise<AgentEvent[]>
}

export function createDelivery(deps: { rpc(): Rpc; thread(): string; running(): string | null }): Delivery {
  const own = new Map<PromptId, Waiting>()

  async function start(prompt: Prompt, input: unknown[], summary: string): Promise<void> {
    own.set(prompt.id, { input, via: "start", late: deps.running() !== null, left: false })
    try {
      await deps.rpc().request("turn/start", {
        threadId: deps.thread(),
        input,
        clientUserMessageId: prompt.id,
        summary,
      })
    } catch (error) {
      own.delete(prompt.id)
      throw error
    }
  }

  async function queue(id: PromptId, input: unknown[]): Promise<void> {
    own.set(id, { input, via: "queue", late: false, left: false })
    try {
      await deps.rpc().request("thread/queue/add", { threadId: deps.thread(), input, clientUserMessageId: id })
    } catch (error) {
      own.delete(id)
      throw error
    }
  }

  // A turn that ended meanwhile leaves the prompt to start one of its own; one Codex cannot steer (a compaction)
  // leaves it to the queue.
  async function steer(prompt: Prompt, input: unknown[], summary: string, turn: string, again = true) {
    own.set(prompt.id, { input, via: "steer", late: false, left: false })
    try {
      await deps.rpc().request("turn/steer", {
        threadId: deps.thread(),
        input,
        clientUserMessageId: prompt.id,
        expectedTurnId: turn,
      })
    } catch (error) {
      own.delete(prompt.id)
      if (!(error instanceof RpcError)) throw error
      const other = OTHER_TURN.exec(error.message)?.[1]
      if (other !== undefined && again) return steer(prompt, input, summary, other, false)
      if (NO_TURN.test(error.message)) return start(prompt, input, summary)
      log.info("codex: a steer was refused, so the prompt waits in the queue", error.message)
      return queue(prompt.id, input)
    }
  }

  async function queued() {
    const listed = resultOf(
      await deps
        .rpc()
        .request("thread/queue/list", { threadId: deps.thread() })
        .catch(() => null),
      queuePage,
      "thread/queue/list",
    )
    return listed.kind === "ok" ? listed.value.data : null
  }

  async function startQueue(): Promise<void> {
    if (![...own.values()].some((waiting) => waiting.via === "queue" && !waiting.left)) return
    await deps
      .rpc()
      .request("thread/queue/start", { threadId: deps.thread() })
      .catch((error: unknown) => log.warn("codex: the queue did not start again", String(error)))
  }

  return {
    send(prompt, input, summary) {
      const turn = deps.running()
      if (turn === null) return start(prompt, input, summary)
      if (prompt.delivery === "queue") return queue(prompt.id, input)
      return steer(prompt, input, summary, turn)
    },

    told(events) {
      const taken: AgentEvent[] = []
      for (const event of events) {
        if (event.type !== "user" || event.history || event.prompt === null) continue
        const waiting = own.get(event.prompt)
        if (!waiting) continue
        own.delete(event.prompt)
        if (waiting.via !== "start" || waiting.late || !event.cutPoint)
          taken.push({ type: "user.taken", prompts: [event.prompt], at: event.at })
      }
      return [...events, ...taken]
    },

    async queueChanged() {
      const rows = await queued()
      if (rows === null) return
      const still = new Set(rows.map((row) => row.clientUserMessageId))
      for (const [id, waiting] of own) if (waiting.via === "queue" && !still.has(id)) waiting.left = true
    },

    async withdraw(prompt) {
      const waiting = own.get(prompt)
      if (waiting?.via !== "queue" || waiting.left) return false
      const row = (await queued())?.find((one) => one.clientUserMessageId === prompt)
      if (!row) return false
      const deleted = await deps
        .rpc()
        .request("thread/queue/delete", { threadId: deps.thread(), queuedSubmissionId: row.id })
        .then((reply) => queueDeleted.safeParse(reply).data?.deleted === true)
        .catch(() => false)
      if (deleted) own.delete(prompt)
      return deleted
    },

    async turnEnded(ours, at) {
      const dropped: PromptId[] = []
      const again: [PromptId, unknown[]][] = []
      for (const [id, waiting] of own) {
        if (waiting.via === "start") waiting.late = true
        else if (waiting.via === "steer" && ours) again.push([id, waiting.input])
        else if (waiting.via === "steer" || waiting.left) dropped.push(id)
      }
      for (const id of dropped) own.delete(id)
      for (const [id, input] of again) {
        // oxlint-disable-next-line no-await-in-loop -- the queue keeps the order they were typed in
        await queue(id, input).catch(() => {
          dropped.push(id)
        })
      }
      if (ours) await startQueue()
      return dropped.map((prompt) => ({ type: "user.dropped", prompt, at }))
    },
  }
}
