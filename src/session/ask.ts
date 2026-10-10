import type { Ask } from "./types.ts"

export function severe(ask: Ask): boolean {
  return ask.defaultToNo || ask.safetyCheck
}
