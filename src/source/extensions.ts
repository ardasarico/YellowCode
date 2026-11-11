import { z } from "zod"
import type { LiveProvider } from "../agents/claude/provider.ts"
import { log } from "../log/log.ts"
import { parseJson, rowsOf } from "../json.ts"
import { type ProtocolMessage, settingsSources, skillRow, skillsDialog } from "../protocol/messages.ts"
import { getSettingsRequest, getSkillsDialogRequest } from "../protocol/outgoing.ts"
import type { SessionStore } from "../session/session.ts"
import { printable } from "../ui/format.ts"
import { type CliResult, runClaude } from "./claude-cli.ts"
import { type Requests, RequestTimeout } from "./requests.ts"

// Live only: the skills and setting sources claude reports (the dialogs' lists), and skill on/off through claude's
// own settings editor.
export type Extensions = {
  initialized(reply: unknown): void
  onMessage(message: ProtocolMessage): void
  refresh(): void
  // A rejection says what went wrong.
  skills: { setEnabled(skill: { name: string; label: string }, enabled: boolean): Promise<void> }
  // Its claude is being replaced: no more asking, and skills it left waiting show their state again.
  dispose(): void
}

// A burst of commands_changed (claude's file watcher) asks once.
const REFRESH_DELAY_MS = 300
// claude reads a changed skillOverrides on its own, 0.2–2.4 s after the edit wrote it; a skill shows its new state
// until claude reports it, or this long after the edit.
const SKILL_SETTLE_MS = 5000
const ENDED = "Claude Code exited"

const editReply = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

// claude prints its result as the last line of stdout.
const lastJson = (stdout: string): unknown => {
  const json = parseJson(stdout.trim().split("\n").at(-1) ?? "")
  return json.ok ? json.value : null
}

function cliFailure(result: CliResult, message: string | undefined): string {
  if (result.code === null) return "Claude Code did not answer"
  return (
    message ||
    result.stderr.split("\n")[0] ||
    (result.code === 0 ? "Claude Code did not report the change" : `Claude Code exited with code ${result.code}`)
  )
}

const failureText = (error: unknown) =>
  error instanceof RequestTimeout
    ? "Claude Code did not answer"
    : printable(error instanceof Error ? error.message : String(error))

export function createExtensions(options: {
  requests: Requests
  provider: LiveProvider
  session: SessionStore
  cwd: string
}): Extensions {
  const { requests, provider, session, cwd } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  let asking = false
  let again = false
  let disposed = false
  // Skills whose edit runs; skills showing a state claude has not reported yet, and who waits to hear how it went.
  const editing = new Set<string>()
  const pending = new Map<
    string,
    { enabled: boolean; timer?: ReturnType<typeof setTimeout>; done?: (picked: boolean) => void }
  >()

  const settle = (name: string, picked = true) => {
    const waiting = pending.get(name)
    clearTimeout(waiting?.timer)
    pending.delete(name)
    provider.setPendingSkill(name, null)
    waiting?.done?.(picked)
  }

  // A late reply from a claude that was replaced must not overwrite what its successor reports.
  const readSkills = (reply: unknown) => {
    if (disposed) return
    const dialog = skillsDialog.safeParse(reply)
    if (!dialog.success) return log.warn("skills reply", "no skills array")
    const { rows, dropped } = rowsOf(skillRow, dialog.data.skills)
    if (dropped > 0) log.warn("skills reply", `dropped ${dropped} of ${dialog.data.skills.length} rows`)
    log.info("skills", { rows: rows.length, off: rows.filter((row) => row.state === "off").length })
    provider.setSkillRows(rows)
    for (const [name, { enabled }] of pending) {
      const row = rows.find((entry) => entry.name === name)
      if (!row || (row.state !== "off") === enabled) settle(name)
    }
  }

  // The reply also holds permission rules and env, which are never kept or logged.
  const readSources = (reply: unknown) => {
    if (disposed) return
    const parsed = settingsSources.safeParse(reply)
    if (!parsed.success) return log.warn("settings reply", "no setting sources")
    log.info("setting sources", { sources: parsed.data.sources.length })
    provider.setSettingsSources(
      parsed.data.sources.map(({ source, settings }) => ({
        source,
        settings: settings.enabledPlugins ? { enabledPlugins: settings.enabledPlugins } : {},
      })),
    )
  }

  const ask = (build: (requestId: string) => string, what: string, read: (reply: unknown) => void) =>
    requests.send(build).then(read, (error: unknown) => log.warn(`${what} failed`, failureText(error)))

  const run = () => {
    timer = undefined
    if (disposed || session.state.status === "ended") return
    asking = true
    void Promise.all([
      ask(getSkillsDialogRequest, "skills dialog", readSkills),
      ask(getSettingsRequest, "settings", readSources),
    ]).finally(() => {
      asking = false
      if (!again) return
      again = false
      refresh()
    })
  }

  const refresh = () => {
    if (asking) {
      again = true
      return
    }
    clearTimeout(timer)
    timer = setTimeout(run, REFRESH_DELAY_MS)
  }

  return {
    // The lists are wanted before the first message, so this one does not wait.
    initialized: run,
    onMessage(message) {
      if (message.type !== "system") return
      if (message.subtype === "commands_changed") refresh()
      else if (message.subtype === "init") {
        provider.setInitLists({ skills: message.skills, slashCommands: message.slash_commands ?? [] })
      }
    },
    refresh,
    dispose() {
      disposed = true
      clearTimeout(timer)
      for (const name of pending.keys()) settle(name)
    },
    skills: {
      async setEnabled(skill, enabled) {
        if (session.state.status === "ended") throw new Error(ENDED)
        if (editing.has(skill.name)) return
        const row = provider.skillRows()?.find((entry) => entry.name === skill.name)
        editing.add(skill.name)
        // A wait for an earlier change of this skill ends here, quietly.
        settle(skill.name)
        pending.set(skill.name, { enabled })
        provider.setPendingSkill(skill.name, enabled)
        log.info(`skill ${enabled ? "on" : "off"}`, { name: skill.name })
        try {
          const state = enabled ? "on" : "off"
          const result = await runClaude(["edit-skill-overrides", "--json"], {
            cwd,
            stdin: JSON.stringify({ name: skill.name, state, handles: row?.handles ?? {} }),
          })
          const reply = editReply.safeParse(lastJson(result.stdout)).data
          if (result.code !== 0 || !reply?.ok) throw new Error(cliFailure(result, reply?.error))
        } catch (error) {
          settle(skill.name)
          throw new Error(failureText(error), { cause: error })
        } finally {
          editing.delete(skill.name)
        }
        refresh()
        const picked = await new Promise<boolean>((resolve) => {
          const waiting = pending.get(skill.name)
          if (!waiting) return resolve(true)
          waiting.done = resolve
          waiting.timer = setTimeout(() => {
            settle(skill.name, false)
            refresh()
          }, SKILL_SETTLE_MS)
        })
        if (!picked) throw new Error(`Claude Code has not picked up the change to ${skill.label} yet`)
      },
    },
  }
}
