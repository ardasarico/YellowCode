import { z } from "zod"
import type { LiveProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import {
  hooksListing,
  pluginHook,
  pluginRow,
  type ProtocolMessage,
  reloadPluginsReply,
  settingsSources,
  skillRow,
  skillsDialog,
} from "../protocol/messages.ts"
import {
  getHooksListingRequest,
  getSettingsRequest,
  getSkillsDialogRequest,
  reloadPluginsRequest,
} from "../protocol/outgoing.ts"
import { type Plugin, pluginScope, pluginSettingId } from "../session/plugins.ts"
import type { SessionStore } from "../session/session.ts"
import { printable } from "../ui/format.ts"
import type { PluginActions } from "../ui/settings/plugins-tab.tsx"
import type { SkillActions } from "../ui/skills/skills-dialog.tsx"
import { type CliResult, runClaude } from "./claude-cli.ts"
import { commandsOf } from "./controls.ts"
import { mcpServers } from "./mcp.ts"
import { type Requests, RequestTimeout } from "./requests.ts"

// Live only: the skills, setting sources and plugin hooks claude reports (the dialogs' lists), and skill and plugin
// on/off through claude's own settings editors.
export type Extensions = {
  initialized(reply: unknown): void
  onMessage(message: ProtocolMessage): void
  refresh(): void
  skills: SkillActions
  plugins: PluginActions
  // Its claude is being replaced: no more asking, and skills it left waiting show their state again.
  dispose(): void
}

// A burst of commands_changed (claude's file watcher) asks once.
const REFRESH_DELAY_MS = 300
const RELOAD_TIMEOUT_MS = 60_000
// claude reads a changed skillOverrides on its own, 0.2–2.4 s after the edit wrote it; a skill shows its new state
// until claude reports it, or this long after the edit.
const SKILL_SETTLE_MS = 5000
const ENDED = "Claude Code exited"

// The file `claude plugin enable|disable --scope` writes, named in the notice, since the project one is shared.
const SCOPE_FILES = {
  user: "user settings",
  project: "project settings (.claude/settings.json)",
  local: "local settings (.claude/settings.local.json)",
}

const editReply = z.looseObject({ ok: z.boolean(), error: z.string().optional() })
const pluginReply = z.looseObject({
  outcome: z.string(),
  message: z.string().optional(),
  failureCode: z.string().optional(),
})

// claude prints its result as the last line of stdout.
const lastJson = (stdout: string): unknown => {
  const json = parseJson(stdout.trim().split("\n").at(-1) ?? "")
  return json.ok ? json.value : null
}

function cliFailure(result: CliResult, message: string | undefined): string {
  if (result.code === null) return "Claude Code did not answer"
  return message || result.stderr.split("\n")[0] || `Claude Code exited with code ${result.code}`
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
  // Skills whose edit runs; skills showing a state claude has not reported yet, and who waits to hear how it went;
  // plugins being switched, and to which state.
  const editing = new Set<string>()
  const pending = new Map<
    string,
    { enabled: boolean; timer?: ReturnType<typeof setTimeout>; done?: (picked: boolean) => void }
  >()
  const switching = new Map<string, boolean>()
  // Plugin errors as of the last reload; a switch reports only new ones. init leaves some out (a broken hooks.json),
  // so it is no baseline, and the first switch has none.
  let pluginErrors: number | null = null

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
    const rows = dialog.data.skills.flatMap((value) => {
      const row = skillRow.safeParse(value)
      return row.success ? [row.data] : []
    })
    const dropped = dialog.data.skills.length - rows.length
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
        settings: {
          ...(settings.enabledPlugins ? { enabledPlugins: settings.enabledPlugins } : {}),
          ...(settings.skillOverrides ? { skillOverrides: settings.skillOverrides } : {}),
        },
      })),
    )
  }

  // A hook row also holds its command, which is never kept.
  const readHooks = (reply: unknown) => {
    if (disposed) return
    const listing = hooksListing.safeParse(reply)
    if (!listing.success) return log.warn("hooks reply", "no hooks array")
    provider.setPluginHooks(
      listing.data.hooks.flatMap((value) => {
        const hook = pluginHook.safeParse(value)
        return hook.success
          ? [{ event: hook.data.event, matcher: hook.data.matcher, pluginName: hook.data.pluginName }]
          : []
      }),
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
      ask(getHooksListingRequest, "hooks listing", readHooks),
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

  // The plugin list, commands and MCP servers come with the reply; the setting sources go with them, so a plugin
  // turned off moves to the off list in the same update. Resolves with the number of new plugin errors.
  const reload = async () => {
    const reply = reloadPluginsReply.safeParse(await requests.send(reloadPluginsRequest, RELOAD_TIMEOUT_MS))
    if (disposed) return 0
    readSources(await requests.send(getSettingsRequest).catch(() => null))
    if (disposed) return 0
    refresh()
    if (!reply.success) {
      log.warn("reload plugins reply", "no lists")
      return 0
    }
    const plugins = reply.data.plugins.flatMap((value) => {
      const row = pluginRow.safeParse(value)
      return row.success ? [{ name: row.data.name, path: row.data.path, source: row.data.source ?? null }] : []
    })
    provider.setCommands(commandsOf(reply.data.commands))
    session.setLists({ plugins, mcpServers: mcpServers(reply.data.mcpServers) })
    const errors = reply.data.error_count ?? 0
    const added = pluginErrors === null ? 0 : errors - pluginErrors
    pluginErrors = errors
    return added
  }

  // What claude's CLI did, when the reload that would show it did not come.
  const assume = (plugin: Plugin, enabled: boolean) => {
    const others = (session.state.plugins ?? session.state.info?.plugins ?? []).filter(
      (entry) => entry.name !== plugin.name,
    )
    session.setLists({
      plugins: enabled ? [...others, { name: plugin.name, path: "", source: pluginSettingId(plugin) }] : others,
    })
  }

  return {
    // The lists are wanted before the first message, so this one does not wait.
    initialized: run,
    onMessage(message) {
      if (message.type !== "system") return
      if (message.subtype === "commands_changed") refresh()
      else if (message.subtype === "init") {
        provider.setInitLists({ skills: message.skills, slashCommands: message.slash_commands ?? [] })
        // init is newer than the list of the last reload.
        if (session.state.plugins) session.setLists({ plugins: null })
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
    plugins: {
      async setEnabled(plugin, enabled) {
        if (session.state.status === "ended") throw new Error(ENDED)
        const id = pluginSettingId(plugin)
        const running = switching.get(id)
        if (running !== undefined) throw new Error(`${plugin.name} is still turning ${running ? "on" : "off"}`)
        switching.set(id, enabled)
        try {
          // The scope decides which settings file claude writes, so it comes from the sources as they are now.
          readSources(await requests.send(getSettingsRequest).catch(() => null))
          const scope = pluginScope(plugin, provider.settingsSources())
          if (scope === null) throw new Error(`${plugin.name} cannot be turned on or off here`)
          log.info(`plugin ${enabled ? "on" : "off"}`, { id, scope })
          const result = await runClaude(["plugin", enabled ? "enable" : "disable", id, "--json", "--scope", scope], {
            cwd,
          })
          const reply = pluginReply.safeParse(lastJson(result.stdout)).data
          // A row that was behind: what was asked for is already so, and the reload shows it.
          const done = (result.code === 0 && reply?.outcome === "ok") || reply?.failureCode === "already_in_goal_state"
          if (!done) {
            refresh()
            throw new Error(cliFailure(result, reply?.message))
          }
          const added = await reload().catch((error: unknown) => {
            assume(plugin, enabled)
            refresh()
            throw error
          })
          const shown = `Turned ${enabled ? "on" : "off"} ${plugin.name} · ${SCOPE_FILES[scope]}`
          if (added <= 0) return shown
          return `${shown} · ${added === 1 ? "1 new plugin error" : `${added} new plugin errors`}`
        } catch (error) {
          throw new Error(failureText(error), { cause: error })
        } finally {
          switching.delete(id)
        }
      },
    },
  }
}
