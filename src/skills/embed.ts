// The skills' files, read from a checkout: tools/build.ts puts them into a standalone binary, a run from source reads
// its own.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const DOCS = ["usage.md", "how-it-works.md", "agents.md", "mods.md", "themes.md"]
const EXAMPLES = ["git", "csv", "terminal"]

function folder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? folder(join(path, entry.name)) : [join(path, entry.name)],
  )
}

// The skills' files by their path in the skills folder.
export function skillFiles(repo: string): Record<string, string> {
  const read = (path: string) => readFileSync(join(repo, path), "utf8")
  const files: Record<string, string> = {
    "skills/yellowcode-docs/SKILL.md": read("src/skills/yellowcode-docs/SKILL.md"),
    "skills/yellowcode-mods/SKILL.md": read("src/skills/yellowcode-mods/SKILL.md"),
    "skills/yellowcode-mods/mod-api.md": read("docs/mod-api.md"),
  }
  for (const name of DOCS) files[`skills/yellowcode-docs/${name}`] = read(`docs/${name}`)
  for (const mod of EXAMPLES)
    for (const path of folder(join(repo, "mods", mod)))
      if (!path.endsWith(".test.ts"))
        files[`skills/yellowcode-mods/examples/${mod}/${relative(join(repo, "mods", mod), path)}`] = readFileSync(
          path,
          "utf8",
        )
  return files
}
