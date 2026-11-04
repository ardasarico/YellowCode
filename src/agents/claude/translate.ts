import type { Ask } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { ProtocolMessage } from "../../protocol/messages.ts"
import { parse, type ParseResult } from "../../protocol/parse.ts"
import type { SessionEnd } from "../../session/types.ts"
import { agentCallOf, type SessionStore } from "../../session/session.ts"
import type { SourceEvent } from "../../source/source.ts"
import { createAsks } from "./asks.ts"
import { showServers } from "./mcp-rows.ts"
import type { Draft } from "./draft.ts"
import { createRelay } from "./relay.ts"
import { createStream } from "./stream.ts"
import { createSystem, limitsOf, systemOf } from "./system.ts"
import { createTasks } from "./tasks.ts"
import { createTools } from "./tools.ts"
import { userOf } from "./user.ts"

type Dir = SourceEvent["dir"]

type ClaudeTranslator = {
  translate(dir: Dir, parsed: ParseResult, at: number): AgentEvent[]
  // The stream cursors outlive a restart, so the new process's first message_start ends the parts the old one left
  // open.
  restart(): void
  // Running work stops, as the store's stopRunning has it.
  stopRunning(): void
  end(): void
  // A held call of our own ask, now known to be the main agent's.
  openHeld(toolUseId: string): Ask | null
  // Our interrupt failed or timed out; a late reply to it changes nothing.
  interruptFailed(): void
}

function createTranslator(session?: SessionStore): ClaudeTranslator {
  const relay = createRelay()
  const tools = createTools(relay)
  const tasks = createTasks(tools, (task) => (session ? agentCallOf(session.state, task) : null))
  const stream = createStream(tools, relay, tasks)
  const asks = createAsks(tools)
  const system = createSystem()
  // The next line in is the first one since claude (re)started.
  let fresh = true
  // The request id of our latest interrupt, until its reply comes.
  let interruptId: string | null = null

  function incoming(message: ProtocolMessage): Draft[] {
    switch (message.type) {
      case "stream_event":
        return stream.streamEvent(message)
      case "assistant":
        return message.is_api_error_message ? system.apiError(message) : stream.assistant(message)
      case "result":
        relay.finish()
        return [...stream.finish(), ...system.result(message)]
      case "user":
        return tasks.results(tools.results(message))
      case "conversation_reset":
        stream.reset()
        tasks.reset()
        return [{ type: "reset" }]
      case "system": {
        if (message.subtype === "local_command_output") return stream.localOutput(message.content)
        if (message.subtype === "status" && message.status === "requesting") relay.requesting()
        if (message.subtype === "init") return [tasks.opened(message), ...system.init(message)]
        return tasks.system(message) ?? systemOf(message) ?? []
      }
      case "control_request":
        return asks.request(message)
      case "control_cancel_request":
        return asks.cancel(message)
      case "control_response": {
        const output = tasks.response(message)
        if (output) return output
        if (message.response.request_id !== interruptId) return []
        interruptId = null
        return [{ type: "interrupt", state: "answered" }]
      }
      case "rate_limit_event":
        return limitsOf(message)
      case "command_lifecycle":
        if (message.state === "queued") return []
        if (message.state === "cancelled") return [{ type: "user.withdrawn", prompt: message.command_uuid }]
        return [{ type: "user.taken", prompts: [message.command_uuid] }]
      case "tool_progress":
        break
    }
    return []
  }

  function outgoing(message: ProtocolMessage): Draft[] {
    if (message.type === "control_response") return asks.reply(message)
    if (message.type === "control_request") {
      const drafts = tasks.request(message)
      if (drafts) return drafts
      if (message.request.subtype !== "interrupt") return []
      interruptId = message.request_id
      return [{ type: "interrupt", state: "asked" }]
    }
    if (message.type !== "user") return []
    relay.sent(message)
    return [{ type: "user", ...userOf(message) }]
  }

  return {
    translate(dir, parsed, at) {
      const events: AgentEvent[] = []
      if (dir === "in" && fresh) {
        fresh = false
        events.push({ type: "ready", at })
      }
      if (parsed.kind === "invalid") events.push({ type: "unreadable", what: parsed.key, at })
      else if (parsed.kind === "message")
        for (const draft of dir === "out" ? outgoing(parsed.message) : incoming(parsed.message))
          events.push({ ...draft, at })
      if (events.length === 0) events.push({ type: "seen", at })
      return events
    },
    restart() {
      fresh = true
      interruptId = null
      relay.stop()
      asks.stop()
      tasks.restart()
    },
    stopRunning: () => tasks.stopRunning(),
    end() {
      stream.stop()
      relay.stop()
      asks.stop()
    },
    openHeld: (toolUseId) => asks.openHeld(toolUseId),
    interruptFailed() {
      interruptId = null
    },
  }
}

// One translator per session. What holds for the whole conversation (task types, tool names) outlives a restart;
// what belongs to one claude process is dropped by `restartSession` and `endSession`.
const translators = new WeakMap<SessionStore, ClaudeTranslator>()

function translatorOf(session: SessionStore): ClaudeTranslator {
  let translator = translators.get(session)
  if (!translator) {
    translator = createTranslator(session)
    translators.set(session, translator)
  }
  return translator
}

export function feed(session: SessionStore, dir: Dir, parsed: ParseResult, at: number): void {
  for (const event of translatorOf(session).translate(dir, parsed, at)) {
    session.event(event)
    if (event.type === "info") showServers(session)
  }
}

// Lines of an earlier session, read by a translator of their own that is then thrown away.
export function translateLines(lines: SourceEvent[]): AgentEvent[] {
  const translator = createTranslator()
  return lines.flatMap((line) => translator.translate(line.dir, parse(line.line), line.at))
}

// The ask server placed a call of our own ask that waited for its tool_use line.
export function openHeldAsk(session: SessionStore, toolUseId: string): void {
  const ask = translatorOf(session).openHeld(toolUseId)
  if (ask) session.event({ type: "ask.open", ask, at: Date.now() })
}

// Settles an ask with the user's answer before the line goes out; its echo then changes nothing.
export function answerSession(session: SessionStore, line: string): void {
  feed(session, "out", parse(line), Date.now())
}

// A prompt shown at Enter, before its line goes out; the line itself still goes through `feed`.
export function showEarly(session: SessionStore, line: string): void {
  const parsed = parse(line)
  if (parsed.kind !== "message" || parsed.message.type !== "user") return
  session.showEarly(userOf(parsed.message))
}

export function interruptFailed(session: SessionStore): void {
  translatorOf(session).interruptFailed()
  session.event({ type: "interrupt", state: "refused", at: Date.now() })
}

export function restartSession(session: SessionStore): void {
  translatorOf(session).restart()
  session.event({ type: "starting", at: Date.now() })
}

// With a problem, claude went away on its own: running work stops and the chat ends with an error row.
export function endSession(session: SessionStore, problem?: SessionEnd): void {
  const translator = translatorOf(session)
  if (problem) translator.stopRunning()
  translator.end()
  session.event({ type: "ended", problem: problem ?? null, at: Date.now() })
}
