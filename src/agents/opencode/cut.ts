// opencode cuts a conversation in two steps: a stage hides a prompt and what follows it and can be cleared, and a
// commit deletes them. YellowCode stages at once and commits with the next send; the files are YellowCode's own
// rewind's. Its own requests come back as events, which are dropped here; another client's become `cut`, `cut.undone`
// and `cut.committed`.
import type { AgentEvent } from "../../agent/events.ts"
import { promptOf } from "./prompts.ts"
import type { OpencodeEvent } from "./wire/events.ts"

export type Revert = { type: "staged"; message: string } | { type: "cleared" } | { type: "committed"; message: string }

type Watched = { want: Revert; done: () => void }

const same = (a: Revert, b: Revert) =>
  a.type === b.type && (a.type === "cleared" || (b.type !== "cleared" && a.message === b.message))

export type Cuts = ReturnType<typeof createCuts>

// `forget`: a commit deleted this message and the ones after it; it gives back the ids it knew of them.
export function createCuts(forget: (message: string) => string[]) {
  // What opencode holds staged, as far as YellowCode knows.
  let staged: string | null = null
  // A stage the session already had when it was opened; its history hides that span.
  let opened: string | null = null
  // Messages a commit deleted, ours or another client's.
  const deleted = new Set<string>()
  const watched: Watched[] = []
  // Clearing a stage runs an execution. Its start is held until its end shows it was empty; a step or an end with an
  // error lets it through ("passed"), as a turn, which opencode runs when a prompt was parked while staged.
  let empty: "next" | OpencodeEvent | "passed" | null = null
  // Our own clear settles once that execution is over, so the next request does not find the session busy.
  let clearing: (() => void) | null = null

  const settle = () => {
    clearing?.()
    clearing = null
  }

  function committed(message: string): void {
    staged = null
    opened = null
    deleted.add(message)
    for (const id of forget(message)) deleted.add(id)
  }

  // True when the event answers a request of ours.
  function mine(found: Revert): boolean {
    const at = watched.findIndex((item) => same(item.want, found))
    const [item] = at < 0 ? [] : watched.splice(at, 1)
    if (!item) return false
    if (found.type === "cleared") clearing = item.done
    else item.done()
    return true
  }

  function revert(event: OpencodeEvent, at: number): AgentEvent[] {
    const known = staged
    if (event.type === "session.revert.staged") {
      const message = event.data.revert.messageID
      staged = message
      if (mine({ type: "staged", message }) || known === message) return []
      return [{ type: "cut", before: promptOf(message), at }]
    }
    if (event.type === "session.revert.cleared") {
      staged = null
      opened = null
      empty = "next"
      if (mine({ type: "cleared" }) || known === null) return []
      return [{ type: "cut.undone", at }]
    }
    if (event.type === "session.revert.committed") {
      const message = event.data.to
      committed(message)
      if (mine({ type: "committed", message })) return []
      const final = { type: "cut.committed", at } as const
      return known === message ? [final] : [{ type: "cut", before: promptOf(message), at }, final]
    }
    return []
  }

  return {
    staged: () => staged,
    // The stage, when it is the one the session was opened with.
    opened: () => (staged !== null && staged === opened ? staged : null),
    // True once a commit deleted this message.
    deleted: (message: string) => deleted.has(message),
    // A request of ours goes out; its event is not another client's. `settled` resolves once it came.
    watch(want: Revert): { settled: Promise<void>; drop(): void } {
      const done = Promise.withResolvers<void>()
      const item = { want, done: done.resolve }
      watched.push(item)
      return {
        settled: done.promise,
        drop() {
          const at = watched.indexOf(item)
          if (at >= 0) watched.splice(at, 1)
          if (clearing === item.done) clearing = null
        },
      }
    },
    // opencode answered a request of ours; its event may come later.
    applied(done: Revert): void {
      if (done.type === "committed") return committed(done.message)
      staged = done.type === "staged" ? done.message : null
      opened = null
    },
    // The session was opened with this stage.
    open(message: string): void {
      staged = message
      opened = message
    },
    // A session read again: the stage known was committed while the stream was down.
    committedElsewhere(at: number): AgentEvent[] {
      if (staged === null) return []
      committed(staged)
      return [{ type: "cut.committed", at }]
    },
    // A session read again says what it holds staged.
    found(message: string | null, at: number): AgentEvent[] {
      const known = staged
      staged = message
      if (known === message) return []
      return [message === null ? { type: "cut.undone", at } : { type: "cut", before: promptOf(message), at }]
    },
    // An event of the session or of its subagents: what to tell of it now, and the events to translate in its place.
    read(event: OpencodeEvent, session: string, at: number): { told: AgentEvent[]; passed: OpencodeEvent[] } {
      const data: object = event.data
      if (!("sessionID" in data) || data.sessionID !== session) return { told: [], passed: [event] }
      if (event.type.startsWith("session.revert.")) return { told: revert(event, at), passed: [] }
      if (empty === "next" && event.type === "session.execution.started") {
        empty = event
        return { told: [], passed: [] }
      }
      if (empty === null || empty === "next") return { told: [], passed: [event] }
      const ends = event.type.startsWith("session.execution.") && event.type !== "session.execution.started"
      if (empty === "passed") {
        if (ends) {
          empty = null
          settle()
        }
        return { told: [], passed: [event] }
      }
      const held = empty
      if (event.type === "session.execution.succeeded") {
        empty = null
        settle()
        return { told: [], passed: [] }
      }
      if (!ends && event.type !== "session.step.started") return { told: [], passed: [event] }
      empty = ends ? null : "passed"
      if (ends) settle()
      return { told: [], passed: [held, event] }
    },
  }
}
