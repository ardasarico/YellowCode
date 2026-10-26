import { existsSync } from "node:fs"
import { join, relative } from "node:path"

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const { tool_input } = await Bun.stdin.json()
const file = relative(projectDir, tool_input.file_path)

const formatter = join(projectDir, "node_modules/.bin/oxfmt")

if (!file.startsWith("..") && existsSync(formatter)) {
  Bun.spawnSync([formatter, "--no-error-on-unmatched-pattern", file], { cwd: projectDir })
}
