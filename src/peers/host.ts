import { basename } from "node:path"
import type { ClientTool } from "../agent/agent.ts"
import { loadImage } from "../input/image-file.ts"
import { type Inbox, openInbox, type PeerAnswer, type PeerMessage } from "./inbox.ts"
import { deliver } from "./outbox.ts"
import { defaultPeersDir, listPeers, openRegistry, type PeerState } from "./registry.ts"
import { projectOf } from "./project.ts"
import { gitDiff, type PeerContext, peerClientTools } from "./tools.ts"

export type PeerSelf = Omit<PeerState, "cwd" | "project">

export type PeerHost = {
  tools: ClientTool[]
  update(patch: Partial<PeerSelf>): void
  // How a message goes out as this session's prompt; false when the agent cannot take one now.
  sendWith(send: (message: PeerMessage) => boolean): void
  // Holds a message for the user's approval instead of running it; false lets it run.
  holdWith(hold: (id: string, message: PeerMessage) => boolean): void
  // The user's answer to a held message.
  release(id: string, run: boolean): void
  // How the user is asked before a broadcast goes to every session on the machine.
  confirmWith(confirm: (message: string) => Promise<boolean>): void
  close(): void
}

// This session's place among the others: its record, its inbox, the queue of messages it holds for its next idle
// moment, and the tools its agent gets.
export async function startPeers(cwd: string, start: PeerSelf, dir = defaultPeersDir()): Promise<PeerHost> {
  const project = projectOf(cwd)
  const registry = openRegistry({ ...start, cwd, project }, dir)
  let self = start
  let queue: PeerMessage[] = []
  let send: ((message: PeerMessage) => boolean) | null = null
  let hold: ((id: string, message: PeerMessage) => boolean) | null = null
  let confirm: ((message: string) => Promise<boolean>) | null = null
  const held = new Map<string, PeerMessage>()
  // Set while a sent message has not yet made the session busy, so a second one waits for its own idle moment.
  let starting = false
  let broadcastFrom: string | null = null

  function drain(): void {
    if (self.status !== "idle" || starting || !send) return
    const next = queue[0]
    if (!next) return
    if (!send(next)) return
    queue.shift()
    starting = true
    broadcastFrom = next.broadcast ? next.from.id : null
  }

  function handle(message: PeerMessage): PeerAnswer {
    if (self.hidden) return { error: "hidden" }
    if (message.to !== self.session) return { error: "not-active" }
    const id = crypto.randomUUID()
    if (hold?.(id, message)) {
      held.set(id, message)
      return { ok: "held" }
    }
    const runsNow = self.status === "idle" && !starting && queue.length === 0
    queue.push(message)
    drain()
    return { ok: runsNow ? "run" : "queued" }
  }

  let inbox: Inbox
  try {
    inbox = await openInbox(registry.socket, handle)
  } catch (error) {
    registry.remove()
    throw error
  }

  const context: PeerContext = {
    self: () =>
      self.session === null
        ? null
        : { id: self.session, title: self.title || basename(cwd), agent: self.agent, cwd, project },
    peers: () => listPeers(dir),
    deliver: (record, message) => deliver(record.socket, message),
    loadImage,
    diff: gitDiff,
    broadcastFrom: () => broadcastFrom,
    confirm: (message) => confirm?.(message) ?? Promise.resolve(false),
  }

  return {
    tools: peerClientTools(context),
    update(patch) {
      const was = self.status
      self = { ...self, ...patch }
      registry.update(patch)
      if (self.status === "busy") starting = false
      if (was === "busy" && self.status === "idle") broadcastFrom = null
      // What waited for a session that has ended is not the new one's to run.
      if (patch.session !== undefined) queue = queue.filter((message) => message.to === self.session)
      drain()
    },
    sendWith(next) {
      send = next
      drain()
    },
    holdWith(next) {
      hold = next
    },
    confirmWith(next) {
      confirm = next
    },
    release(id, run) {
      const message = held.get(id)
      held.delete(id)
      if (!message || !run || message.to !== self.session) return
      queue.push(message)
      drain()
    },
    close() {
      inbox.close()
      registry.remove()
    },
  }
}
