import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { parseJson } from "../protocol/json.ts"
import type { ThemeColors, ThemeDefinition } from "./theme.ts"

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)

const Colors = z.object({
  background: color,
  text: color,
  muted: color,
  frame: color,
  accent: color,
  warning: color,
  error: color,
  band: color,
  tile: color,
  selection: color,
  diffAdd: color,
  diffDel: color,
  diffAddText: color,
  diffDelText: color,
  agents: z.array(color).min(1),
  syntax: z.object({ keyword: color, string: color, number: color, function: color, type: color, comment: color }),
}) satisfies z.ZodType<ThemeColors>

const ThemeFile = z
  .object({ name: z.string().min(1), dark: Colors.optional(), light: Colors.optional() })
  .refine((file) => file.dark ?? file.light, { message: "needs dark or light", path: ["dark"] })

export type ThemeSource = "built-in" | "user"

// A theme as the pickers list it: usable (Terminal has no definition, its colors come from the terminal), or with the
// reason it is not.
export type ThemeEntry =
  | { id: string; name: string; source: ThemeSource; definition: ThemeDefinition | null; problem: null }
  | { id: string; name: string; source: ThemeSource; definition: null; problem: string }

// The first thing wrong with a file, like "dark.tile missing" or "light.accent is not a color".
function problemOf(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "is not a theme"
  const path = issue.path.join(".")
  if (issue.code === "invalid_type" && issue.input === undefined) return `${path} missing`
  if (issue.code === "invalid_format" || issue.code === "invalid_type") return `${path} is not a color`
  return path ? `${path}: ${issue.message}` : issue.message
}

export function readTheme(path: string, source: ThemeSource): ThemeEntry {
  const id = basename(path, ".json")
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { id, name: id, source, definition: null, problem: "cannot be read" }
  }
  const json = parseJson(text)
  if (!json.ok) return { id, name: id, source, definition: null, problem: "is not valid JSON" }
  const name = typeof json.value === "object" && json.value !== null && "name" in json.value ? json.value.name : id
  const shown = typeof name === "string" && name !== "" ? name : id
  const parsed = ThemeFile.safeParse(json.value)
  if (!parsed.success) return { id, name: shown, source, definition: null, problem: problemOf(parsed.error) }
  // One variant serves both kinds of terminal.
  const dark = parsed.data.dark ?? parsed.data.light
  const light = parsed.data.light ?? parsed.data.dark
  if (!dark || !light) return { id, name: shown, source, definition: null, problem: "needs dark or light" }
  return { id, name: parsed.data.name, source, definition: { id, name: parsed.data.name, dark, light }, problem: null }
}

function readFolder(folder: string, source: ThemeSource): ThemeEntry[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .toSorted()
    .map((name) => readTheme(join(folder, name), source))
}

export const BUILT_IN_FOLDER = join(import.meta.dir, "../../themes")

// The built-in themes, then the user's; a user theme may not take a built-in theme's id.
export function readThemes(userFolder = configPath("themes")): ThemeEntry[] {
  const builtIn = readFolder(BUILT_IN_FOLDER, "built-in")
  const taken = new Set(builtIn.map((entry) => entry.id))
  const user = readFolder(userFolder, "user").map((entry): ThemeEntry =>
    taken.has(entry.id) || entry.id === "terminal"
      ? { id: entry.id, name: entry.name, source: "user", definition: null, problem: "a built-in theme has this name" }
      : entry,
  )
  return [...builtIn, ...user]
}
