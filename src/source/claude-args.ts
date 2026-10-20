import { protocolMode, type StoredSettings } from "../session/settings-file.ts"
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

// How YellowCode starts claude, from what the user saved. bypassPermissions can be switched to only in a session
// started with the allow flag, so the flag goes along only when that mode is saved.
export function claudeArgs(stored: Pick<StoredSettings, "thinking" | "permissionMode">): string[] {
  const bypass = stored.permissionMode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []
  return [
    ...CLAUDE_STREAM_ARGS,
    thinkingArg(stored.thinking),
    "--permission-mode",
    protocolMode(stored.permissionMode),
    ...bypass,
    "--append-system-prompt",
    APPEND_SYSTEM_PROMPT,
  ]
}
