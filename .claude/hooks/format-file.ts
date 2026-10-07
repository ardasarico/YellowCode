import { join, relative } from "node:path"

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const { tool_input } = await Bun.stdin.json()
const file = relative(projectDir, tool_input.file_path)

if (!file.startsWith("..")) {
  Bun.spawnSync([join(projectDir, "node_modules/.bin/oxfmt"), "--no-error-on-unmatched-pattern", file], { cwd: projectDir })
}
