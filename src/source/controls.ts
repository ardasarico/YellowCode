import { createEffect, createRoot, on } from "solid-js"
import type { LiveProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import {
  appliedSettings,
  commandRows,
  modelInfo,
  type ModelInfo,
  modelRows,
  initializeMode,
  permissionModeReply,
  type ProtocolMessage,
  slashCommand,
  type SlashCommand,
} from "../protocol/messages.ts"
import {
  applyFlagSettingsRequest,
  fileSuggestionsRequest,
  getSettingsRequest,
  setModelRequest,
  setPermissionModeRequest,
  thinkingDisplayRequest,
} from "../protocol/outgoing.ts"
import { modeLabel, protocolMode } from "../session/settings-file.ts"
import type { SessionStore } from "../session/session.ts"
import {
  controlProblem,
  modelChoices,
  modelValue,
  setControlProblem,
  setKnobs,
  setModelChoices,
  settings,
} from "../session/settings.ts"
import { EFFORT_LEVELS, type EffortLevel } from "../theme/brand.ts"
import type { Requests } from "./requests.ts"

// What the user chose for the conversation, or what claude said it uses.
export type Knobs = { model: string | null; effort: EffortLevel | null; ultracode: boolean }

// Live only: what claude offers and uses, read from its initialize reply, get_settings and the messages after them.
export type Controls = {
  // Another live module that takes the same initialize reply and messages, after it was created.
  follow(follower: Follower): void
  initialized(reply: unknown): void
  onMessage(message: ProtocolMessage): void
  // Sends the changes still waiting out their delay, so a message sent right after them goes out under them.
  flush(): void
  // A claude started again for the same conversation gets the knobs it had, before any message goes out.
  carry(knobs: Knobs): void
  // The claude is being replaced: nothing it answers from here on reaches the knobs, the lists or the notices.
  dispose(): void
}

export type Follower = Pick<Controls, "initialized" | "onMessage">

export const commandsOf = (rows: unknown[]): SlashCommand[] =>
  rows.flatMap((row) => {
    const parsed = slashCommand.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

const modelsOf = (rows: unknown[]): ModelInfo[] =>
  rows.flatMap((row) => {
    const parsed = modelInfo.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

const isEffort = (value: string | null | undefined): value is EffortLevel =>
  EFFORT_LEVELS.some((level) => level === value)

export const SEND_DELAY_MS = 300
const ULTRACODE_UNAVAILABLE = "Ultracode is not available for this model"

type Knob = "model" | "effort" | "ultracode" | "thinking" | "permission"

const FAILURES: Record<Knob, string> = {
  model: "Cannot switch the model",
  effort: "Cannot change the effort",
  ultracode: "Cannot change ultracode",
  thinking: "Cannot change the thinking display",
  permission: "Cannot set the permission mode",
}

// claude's own text may already say what failed ("Cannot set permission mode to auto: …").
const failure = (knob: Knob, error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return text.startsWith("Cannot") ? text : `${FAILURES[knob]}: ${text}`
}

export function createControls(options: {
  requests: Requests
  provider: LiveProvider
  session: SessionStore
  // Started with --allow-dangerously-skip-permissions, so bypassPermissions can be switched to.
  bypass: boolean
}): Controls {
  const { requests, provider, session, bypass } = options
  // claude starts in the saved mode when it can, and silently in another one when it cannot (auto turned off, a
  // policy), so the mode it reports first is checked once against the one it was started with.
  const launched = protocolMode(settings.permissionMode)
  let modeChecked = false
  const checkMode = (current: string) => {
    if (modeChecked) return
    modeChecked = true
    if (current !== launched)
      setControlProblem({
        text: `Permission mode ${modeLabel(launched)} is not available, using ${modeLabel(current)}`,
      })
  }
  // What claude said it uses, last. A knob sends only what differs from it, so writing it back to the knobs sends
  // nothing.
  const known: Knobs = { model: null, effort: null, ultracode: false }
  // Changes waiting to go out, or sent and not answered yet.
  const pending = new Set<Knob>()
  const timers = new Map<Knob, { timer: ReturnType<typeof setTimeout>; send: () => void }>()
  let ultracodeAsked = false
  const followers: Follower[] = []
  let disposed = false
  // One that throws must not keep the message from the others, nor end the pump.
  const tell = (call: (follower: Follower) => void) => {
    for (const follower of followers)
      try {
        call(follower)
      } catch (error) {
        log.error("live module failed", error)
      }
  }

  // get_settings is the only source of the model and effort before the first turn (init comes with the first
  // message), and after a change it tells what claude actually applied.
  const refresh = () => {
    requests.send(getSettingsRequest).then(
      (reply) => {
        // The state from before a change still on its way would undo it; the refresh after that change comes later.
        if (disposed || pending.size > 0) return
        const applied = appliedSettings.safeParse(reply).data?.applied
        if (!applied) return log.warn("claude settings: no applied settings in the reply")
        known.model = applied.model ?? null
        known.effort = isEffort(applied.effort) ? applied.effort : null
        known.ultracode = applied.ultracode ?? false
        log.info("claude settings", { ...known })
        // claude takes the request but turns ultracode on only for a model that has it, and on by itself once the
        // model changes to one that has it.
        if (ultracodeAsked && applied.ultracodeRequested && !known.ultracode)
          setControlProblem({ text: ULTRACODE_UNAVAILABLE })
        else if (known.ultracode && controlProblem()?.text === ULTRACODE_UNAVAILABLE) setControlProblem(null)
        ultracodeAsked = false
        setKnobs({ ...known })
      },
      (error: unknown) => log.warn("claude settings failed", error instanceof Error ? error.message : error),
    )
  }

  const settle = (knob: Knob) => {
    if (!timers.has(knob)) pending.delete(knob)
    if (pending.size === 0) refresh()
  }

  // A knob goes out SEND_DELAY_MS after its last change, so Shift+→→→ sends once.
  const wait = (knob: Knob, run: () => void) => {
    if (session.state.status === "ended") return
    pending.add(knob)
    clearTimeout(timers.get(knob)?.timer)
    const send = () => {
      timers.delete(knob)
      run()
    }
    timers.set(knob, { timer: setTimeout(send, SEND_DELAY_MS), send })
  }

  // A refused change gets a notice, and the refresh after it shows claude's state again.
  const change = (knob: Knob, build: (requestId: string) => string, onReply?: (reply: unknown) => void) =>
    wait(knob, () => {
      requests.send(build).then(
        (reply) => {
          onReply?.(reply)
          settle(knob)
        },
        (error: unknown) => {
          if (disposed) return
          if (session.state.status !== "ended") setControlProblem({ text: failure(knob, error) })
          settle(knob)
        },
      )
    })

  const stopEffects = createRoot((dispose) => {
    createEffect(
      on(
        () => settings.model,
        (model) => {
          if (model !== null && model !== known.model) change("model", (id) => setModelRequest(id, modelValue(model)))
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        () => settings.effort,
        (effort) => {
          if (effort === null || effort === known.effort) return
          // An effort sent without the ultracode key would turn ultracode off.
          const flags = { effortLevel: effort, ultracode: settings.ultracode }
          change("effort", (id) => applyFlagSettingsRequest(id, flags))
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        () => settings.ultracode,
        (ultracode) => {
          if (ultracode === known.ultracode) return
          if (ultracode) ultracodeAsked = true
          change("ultracode", (id) => applyFlagSettingsRequest(id, { ultracode }))
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        () => settings.permissionMode,
        (mode) => {
          // The mode is the user's choice from here on, not the launch's.
          modeChecked = true
          // claude switches to bypassPermissions only in a session started with the allow flag; the saved mode
          // brings that flag at the next start. Stepping past it on the way to another mode says nothing.
          if (mode === "bypassPermissions" && !bypass) {
            wait("permission", () => {
              setControlProblem({ text: "bypassPermissions applies from the next start" })
              settle("permission")
            })
            return
          }
          change(
            "permission",
            (id) => setPermissionModeRequest(id, protocolMode(mode)),
            (reply) => {
              const current = permissionModeReply.safeParse(reply).data?.mode
              if (current) session.setPermissionMode(current)
            },
          )
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        () => settings.thinking,
        (thinking) =>
          change("thinking", (id) => thinkingDisplayRequest(id, thinking === "hidden" ? "omitted" : "summarized")),
        { defer: true },
      ),
    )
    return dispose
  })

  const flush = () => {
    for (const { timer, send } of timers.values()) {
      clearTimeout(timer)
      send()
    }
  }

  return {
    follow(follower) {
      followers.push(follower)
    },
    flush,
    carry({ model, effort, ultracode }) {
      if (model !== null) change("model", (id) => setModelRequest(id, modelValue(model)))
      if (effort !== null) change("effort", (id) => applyFlagSettingsRequest(id, { effortLevel: effort, ultracode }))
      else if (ultracode) change("ultracode", (id) => applyFlagSettingsRequest(id, { ultracode }))
      flush()
    },
    dispose() {
      disposed = true
      stopEffects()
      for (const { timer } of timers.values()) clearTimeout(timer)
      timers.clear()
    },
    initialized(reply) {
      if (disposed) return
      const commands = commandRows.safeParse(reply).data?.commands
      if (commands) provider.setCommands(commandsOf(commands))
      const rows = modelRows.safeParse(reply).data?.models
      if (rows) {
        const models = modelsOf(rows)
        provider.setModels(models)
        setModelChoices(modelChoices(models))
      }
      const mode = initializeMode.safeParse(reply).data?.current_permission_mode
      if (mode) {
        session.setPermissionMode(mode)
        checkMode(mode)
      }
      refresh()
      // claude builds its file index on the first non-empty query, which itself answers nothing.
      requests.send((id) => fileSuggestionsRequest(id, "a")).catch(() => {})
      tell((follower) => follower.initialized(reply))
    },
    onMessage(message) {
      if (disposed) return
      if (message.type === "system" && message.subtype === "commands_changed")
        provider.setCommands(commandsOf(message.commands))
      else if (message.type === "system" && message.subtype === "init") {
        provider.setTerminalOnly(message.terminal_slash_commands ?? [])
        // In case the initialize reply did not say.
        checkMode(message.permissionMode)
        // A typed /model or a fallback model shows here first; a switch of our own on its way wins.
        if (message.model !== known.model && !pending.has("model")) {
          known.model = message.model
          setKnobs({ model: message.model })
        }
      } else if (message.type === "result" && message.local_command) refresh()
      tell((follower) => follower.onMessage(message))
    },
  }
}
