// The conversation cut back to before a prompt. A cut waits for the next send, or the chat's go-back before it, so
// `undo` takes it back until then. A paginated thread drops the turns from the prompt's on (thread/revert); a legacy
// one cannot, so the session goes on in a copy made before that turn (owner question 40). Files are left to
// YellowCode's own rewind.
import type { Outcome, PromptId } from "../../agent/ids.ts"
import { log } from "../../log/log.ts"
import { turnOf } from "./history.ts"
import type { Translator } from "./translate.ts"
import { RpcError, type Rpc } from "./transport.ts"
import { page, resultOf, threadStartResult, turn, type ThreadStart } from "./wire/thread.ts"

const REFUSED = "Cannot rewind the conversation to this prompt"
// app-server's words for a thread with legacy history.
const LEGACY = /only supports paginated threads/

export type Cuts = {
  cut(before: PromptId): void
  undo(): void
  pending(): PromptId | null
  // Takes the cut now, at `before` when given, else at the pending one.
  goBack(before: PromptId | null): Promise<Outcome>
  // Codex said the thread was cut back: by us, or by another client, whose cut starts at the prompt this gives.
  reverted(): Promise<PromptId | null>
}

export function createCuts(deps: {
  rpc(): Rpc
  thread(): string
  legacy(): boolean
  lookup: Pick<Translator, "turnOf" | "cutAfter" | "cutFrom">
  // The session goes on in this copy.
  forked(opened: ThreadStart): void
}): Cuts {
  let pending: PromptId | null = null
  // Prompts already cut, for a go-back again after a send that did not go out.
  const gone = new Set<PromptId>()
  // Our reverts whose notification is still to come.
  let ours = 0

  async function revert(beforeTurnId: string): Promise<Outcome> {
    ours += 1
    try {
      await deps.rpc().request("thread/revert", { threadId: deps.thread(), beforeTurnId })
      return { ok: true, note: null }
    } catch (error) {
      ours -= 1
      if (error instanceof RpcError && LEGACY.test(error.message)) return fork(beforeTurnId)
      log.warn("codex: the revert was refused", String(error))
      return { ok: false, problem: REFUSED }
    }
  }

  async function fork(beforeTurnId: string): Promise<Outcome> {
    const reply = await deps
      .rpc()
      .request("thread/fork", { threadId: deps.thread(), beforeTurnId, excludeTurns: true })
      .catch((error: unknown) => {
        log.warn("codex: the copy before the turn was refused", String(error))
        return null
      })
    const opened = resultOf(reply, threadStartResult, "thread/fork")
    if (opened.kind !== "ok") return { ok: false, problem: REFUSED }
    deps.forked(opened.value)
    return { ok: true, note: null }
  }

  return {
    cut(before) {
      pending = before
    },
    undo() {
      pending = null
    },
    pending: () => pending,

    async goBack(before) {
      const target = before ?? pending
      pending = null
      if (target === null || gone.has(target)) return { ok: true, note: null }
      const found = deps.lookup.turnOf(target) ?? (await turnOf(deps.rpc(), deps.thread(), target).catch(() => null))
      if (found === null) return { ok: false, problem: REFUSED }
      const done = deps.legacy() ? await fork(found) : await revert(found)
      if (!done.ok) return done
      gone.add(target)
      for (const prompt of deps.lookup.cutFrom(found)) gone.add(prompt)
      return done
    },

    async reverted() {
      if (ours > 0) {
        ours -= 1
        return null
      }
      const reply = await deps
        .rpc()
        .request("thread/turns/list", {
          threadId: deps.thread(),
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        })
        .catch(() => null)
      const listed = resultOf(reply, page, "thread/turns/list")
      if (listed.kind !== "ok") return null
      const newest = turn.safeParse(listed.value.data[0])
      const cut = deps.lookup.cutAfter(newest.success ? newest.data.id : null)
      // A cut into turns this session only read back names none of its live prompts.
      if (cut.length === 0) log.info("codex: another client cut turns this session did not see live")
      return cut[0] ?? null
    },
  }
}
