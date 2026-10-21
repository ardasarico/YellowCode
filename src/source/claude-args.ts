import { type PermissionMode, protocolMode, type StoredSettings } from "../session/settings-file.ts"
import { APPEND_SYSTEM_PROMPT } from "./append-prompt.ts"

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
// id (fork).
export type Spawn = { resume?: string; fork?: boolean; sessionId?: string }

// The permission mode claude starts in, and whether it may switch to bypassPermissions.
export type Launch = { mode: PermissionMode; bypass: boolean }

// The saved mode, or the mode a restarted session was in. bypassPermissions can be switched to only in a session
// started with the allow flag, so the flag goes along when that mode is saved or the session was in it.
export function launchOf(stored: Pick<StoredSettings, "permissionMode">, mode?: PermissionMode): Launch {
  const launched = mode ?? stored.permissionMode
  return {
    mode: launched,
    bypass: stored.permissionMode === "bypassPermissions" || launched === "bypassPermissions",
  }
}

// How YellowCode starts claude: the saved thinking display, in the launch's mode.
export function claudeArgs(stored: Pick<StoredSettings, "thinking">, launch: Launch, spawn: Spawn = {}): string[] {
  const bypass = launch.bypass ? ["--allow-dangerously-skip-permissions"] : []
  return [
    ...CLAUDE_STREAM_ARGS,
    thinkingArg(stored.thinking),
    // Ahead of the prompt's line breaks, so a process list shows the session on claude's first line.
    ...(spawn.resume ? ["--resume", spawn.resume] : []),
    ...(spawn.fork ? ["--fork-session"] : []),
    ...(spawn.sessionId ? ["--session-id", spawn.sessionId] : []),
    "--permission-mode",
    protocolMode(launch.mode),
    ...bypass,
    "--append-system-prompt",
    APPEND_SYSTEM_PROMPT,
  ]
}
