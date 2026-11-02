// Raw steps over pi's RPC: commands paired to their responses by id, events waited for in order. The recorder runs
// them on a live pi; tests run them on a replay.
import type { Transport } from "../../src/agents/codex/transport.ts"
import { follow, pick } from "../opencode/driver.ts"

export { pick, text } from "../opencode/driver.ts"

export type Event = { type: string } & Record<string, unknown>

export type Driver = {
  // The project folder pi runs in; a fixture has it as <root>/project.
  directory: string
  // Sends a command and resolves with its response's `data`; a response with `success: false` rejects.
  command(type: string, fields?: Record<string, unknown>): Promise<unknown>
  // The next event of `type` (that `match` accepts) after the last one an `until` returned, already arrived or not.
  until(type: string, match?: (event: Event) => boolean, timeoutMs?: number): Promise<Event>
  // Answers an extension UI request.
  answer(id: string, reply: Record<string, unknown>): void
  // Gives the live pi time where no event says it is done. A replay does not wait.
  pause(ms: number): Promise<void>
  close(): Promise<void>
}

export type DriverOptions = {
  directory: string
  onIntent?: (intent: string, args: unknown) => void
  timeoutMs?: number
  live?: boolean
}

const isEvent = (value: unknown): value is Event =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"

export function createDriver(transport: Transport, options: DriverOptions): Driver {
  const timeout = options.timeoutMs ?? 30_000
  const waiting = new Map<string, { resolve(data: unknown): void; reject(error: Error): void }>()
  let next = 0

  async function* events(): AsyncIterable<Event> {
    for await (const raw of transport.messages) {
      if (!isEvent(raw)) continue
      if (raw.type === "response") {
        const id = pick(raw, "id")
        const pending = typeof id === "string" ? waiting.get(id) : undefined
        if (pending && typeof id === "string") {
          waiting.delete(id)
          if (raw["success"] === false) pending.reject(new Error(`${String(raw["command"])}: ${String(raw["error"])}`))
          else pending.resolve(raw["data"])
        }
        continue
      }
      yield raw
    }
    for (const pending of waiting.values()) pending.reject(new Error("pi closed before it answered"))
  }

  const incoming = follow(events(), (event) => event, "pi")

  return {
    directory: options.directory,
    command(type, fields = {}) {
      options.onIntent?.("command", { type, ...fields })
      const id = String(++next)
      const reply = new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }))
      transport.send({ id, type, ...fields })
      return reply
    },
    until(type, match, timeoutMs = timeout) {
      options.onIntent?.("until", { type })
      return incoming.until(type, (event) => event.type === type && (match?.(event) ?? true), timeoutMs)
    },
    answer(id, reply) {
      options.onIntent?.("answer", { id, ...reply })
      transport.send({ type: "extension_ui_response", id, ...reply })
    },
    pause: (ms) => (options.live ? Bun.sleep(ms) : Promise.resolve()),
    close: () => transport.close(),
  }
}

// One prompt, waited for until pi has nothing more to do on its own.
export async function promptAndSettle(d: Driver, message: string, fields: Record<string, unknown> = {}): Promise<void> {
  await d.command("prompt", { message, ...fields })
  await d.until("agent_settled")
}
