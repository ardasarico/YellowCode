import { type PermissionMode, savedMode } from "./settings-file.ts"

// After an approved plan the session goes back to the mode it had before plan mode, or to auto when it began in plan.
export function planReturn() {
  let before: PermissionMode | null = null
  let approved = false
  return {
    approve() {
      approved = true
    },
    cancel() {
      approved = false
    },
    // The mode to ask claude for, if the one it now reports is not the one the session should be in.
    seen(reported: string): PermissionMode | null {
      const mode = savedMode(reported)
      if (reported === "plan") return null
      if (!approved) {
        before = mode
        return null
      }
      approved = false
      const target = before ?? "auto"
      before = target
      return mode === target ? null : target
    },
  }
}
