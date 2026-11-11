import type { OwnMcp } from "../agent/agent.ts"
import type { ModeId } from "../agent/ids.ts"
import type { StoredSettings } from "../session/settings-file.ts"
import { OWN_AGENTS, OWN_ASK, OWN_SESSIONS } from "../protocol/messages.ts"
import { instructionsFor } from "../agent/yellowcode-prompt.ts"

export const CLAUDE_STREAM_ARGS = [
  "-p",
  "--input-format=stream-json",
  "--output-format=stream-json",
  "--verbose",
  "--include-partial-messages",
  "--include-hook-events",
  "--forward-subagent-text",
  "--permission-prompt-tool=stdio",
] as const

// Without the flag claude sends no thinking text at all, so it always goes out.
export function thinkingArg(thinking: StoredSettings["thinking"]): string {
  return `--thinking-display=${thinking === "hidden" ? "omitted" : "summarized"}`
}

// Which conversation claude runs: a new one under a given id, an earlier one (resume), or a copy of one under a new
// id (fork). `at` cuts a resumed one after that message.
export type Spawn = { resume?: string; at?: string; fork?: boolean; sessionId?: string }

// The permission mode claude starts in, and whether it may switch to bypassPermissions.
export type Launch = { mode: ModeId; bypass: boolean }

// The saved mode, or the mode a restarted session was in. bypassPermissions can be switched to only in a session
// started with the allow flag, so the flag goes along when that mode is saved or the session was in it.
export function launchOf(stored: { permissionMode: ModeId }, mode?: ModeId): Launch {
  const launched = mode ?? stored.permissionMode
  return {
    mode: launched,
    bypass: stored.permissionMode === "bypassPermissions" || launched === "bypassPermissions",
  }
}

// A session claude keeps no transcript of, with instructions added to its system prompt. A plain start is not offered:
// --safe-mode would also drop CLAUDE.md.
export type Lean = { ephemeral: boolean; instructions?: string[]; skills?: string[] }

// Each skills folder goes in as a plugin of this run only. Its files sit outside the session's folder, so claude may
// read them unasked.
function skillArgs(skills: readonly string[]): { flags: string[]; reads: string[] } {
  return {
    flags: skills.flatMap((folder) => ["--plugin-dir", folder]),
    reads: skills.map((folder) => `Read(/${folder}/**)`),
  }
}

// claude reads every .mcp.json from its folder up to / by itself and, under -p, runs them unasked. YellowCode hands
// over the project file's servers the user trusts, so claude's own reading is turned off for this run, by name, with
// no file written.
function ownMcpSettings(own: OwnMcp | undefined): Record<string, unknown> {
  return own && own.on && !own.unsure && own.project.length > 0 ? { disabledMcpjsonServers: own.project } : {}
}

// claude has no switch for every plugin, so each installed one is turned off by its id. The folders its
// CLAUDE_CODE_PLUGIN_DIRS names go with them; a --plugin-dir still loads.
function pluginsOffSettings(ids: readonly string[] | undefined): Record<string, unknown> {
  if (!ids) return {}
  return {
    enabledPlugins: Object.fromEntries(ids.map((id) => [id, false])),
    env: { CLAUDE_CODE_PLUGIN_DIRS: "" },
  }
}

// Only the last --settings counts, so everything goes in one.
function settingsArgs(own: OwnMcp | undefined, pluginsOff: readonly string[] | undefined): string[] {
  const settings = { ...ownMcpSettings(own), ...pluginsOffSettings(pluginsOff) }
  return [
    // With no --mcp-config it keeps only the servers YellowCode sets (set-servers and its own sdk servers).
    ...(own && (!own.on || own.unsure) ? ["--strict-mcp-config"] : []),
    ...(Object.keys(settings).length > 0 ? ["--settings", JSON.stringify(settings)] : []),
  ]
}

// How YellowCode starts claude: the saved thinking display, in the launch's mode. `pluginsOff`: the ids of the
// installed plugins this run leaves off (agents/claude/plugins.ts); without it they load.
export function claudeArgs(
  stored: Pick<StoredSettings, "thinking">,
  launch: Launch,
  spawn: Spawn = {},
  lean: Lean = { ephemeral: false },
  own?: OwnMcp,
  pluginsOff?: readonly string[],
): string[] {
  const bypass = launch.bypass ? ["--allow-dangerously-skip-permissions"] : []
  const skills = skillArgs(lean.skills ?? [])
  return [
    ...CLAUDE_STREAM_ARGS,
    // Our own ask replaces the stock one and never waits on a permission ask. These flags take a list, so each is
    // one argument that cannot swallow the next.
    `--allowedTools=${[OWN_ASK, OWN_SESSIONS, OWN_AGENTS, ...skills.reads].join(",")}`,
    "--disallowedTools=AskUserQuestion",
    ...settingsArgs(own, pluginsOff),
    ...skills.flags,
    thinkingArg(stored.thinking),
    // Ahead of the prompt's line breaks, so a process list shows the session on claude's first line.
    ...(spawn.resume ? ["--resume", spawn.resume] : []),
    ...(spawn.resume && spawn.at ? ["--resume-session-at", spawn.at] : []),
    ...(spawn.fork ? ["--fork-session"] : []),
    ...(spawn.sessionId ? ["--session-id", spawn.sessionId] : []),
    ...(lean.ephemeral ? ["--no-session-persistence"] : []),
    "--permission-mode",
    launch.mode,
    ...bypass,
    "--append-system-prompt",
    instructionsFor(lean.instructions ?? []),
  ]
}
