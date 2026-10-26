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
  .transform((file, ctx) => {
    // One variant serves both kinds of terminal.
    const dark = file.dark ?? file.light
    const light = file.light ?? file.dark
    if (!dark || !light) {
      ctx.addIssue({ code: "custom", message: "needs dark or light", path: ["dark"] })
      return z.NEVER
    }
    return { name: file.name, dark, light }
  })

export type ThemeSource = "built-in" | "user"

// A theme as the pickers list it: usable (Terminal has no definition, its colors come from the terminal), or with the
// reason it is not.
export type ThemeEntry =
  | { id: string; name: string; source: ThemeSource; definition: ThemeDefinition | null; problem: null }
  | { id: string; name: string; source: ThemeSource; definition: null; problem: string }

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let value = root
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined
    value = Reflect.get(value, key)
  }
  return value
}

const EXPECTED: Record<string, string> = { array: "a list of colors", object: "a set of colors" }

// The first thing wrong with a file, like "dark.tile missing" or "light.accent is not a color".
function problemOf(error: z.ZodError, json: unknown): string {
  const issue = error.issues[0]
  if (!issue) return "is not a theme"
  const path = issue.path.join(".")
  if (issue.code === "invalid_type") {
    if (path === "") return "is not a theme"
    if (valueAt(json, issue.path) === undefined) return `${path} missing`
    const expected = path === "name" ? "text" : (EXPECTED[issue.expected] ?? "a color")
    return `${path} is not ${expected}`
  }
  if (issue.code === "invalid_format") return `${path} is not a color`
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
  if (!parsed.success)
    return { id, name: shown, source, definition: null, problem: problemOf(parsed.error, json.value) }
  const { name: themeName, dark, light } = parsed.data
  return { id, name: themeName, source, definition: { id, name: themeName, dark, light }, problem: null }
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
