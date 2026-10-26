import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "../../log/log.ts"
import type { Editor } from "../../session/settings-file.ts"
import { settings } from "../../session/settings.ts"

const APPS: Record<Exclude<Editor, "default">, { name: string; app: string; scheme: string }> = {
  zed: { name: "Zed", app: "Zed.app", scheme: "zed" },
  vscode: { name: "VS Code", app: "Visual Studio Code.app", scheme: "vscode" },
  cursor: { name: "Cursor", app: "Cursor.app", scheme: "cursor" },
}

export const editorName = (editor: Editor) => (editor === "default" ? "System default" : APPS[editor].name)

const installed = (app: string) =>
  existsSync(join("/Applications", app)) || existsSync(join(homedir(), "Applications", app))

// System default plus the editors found on this machine; a chosen editor stays listed after it is removed.
export function editorChoices(current: Editor): Editor[] {
  return [
    "default",
    ...(["zed", "vscode", "cursor"] as const).filter((id) => id === current || installed(APPS[id].app)),
  ]
}

// Each path segment is escaped, so a space, "#" or "?" in a name stays part of the path.
export const editorUrl = (scheme: string, path: string, line?: number) =>
  `${scheme}://file${path.split("/").map(encodeURIComponent).join("/")}${line ? `:${line}` : ""}`

const OPENER = process.platform === "darwin" ? "open" : "xdg-open"

async function open(args: string[], command = OPENER): Promise<boolean> {
  try {
    const child = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" })
    if ((await child.exited) === 0) return true
    log.warn("open failed", await new Response(child.stderr).text())
  } catch (error) {
    log.warn("open failed", error)
  }
  return false
}

export const openFolder = (path: string) => open([path])
export const openUrl = (url: string) => open([url])

// False when the chosen editor could not open the file and the default app was used instead.
export async function openFile(path: string, line?: number): Promise<boolean> {
  const editor = settings.editor
  const inEditor = editor === "default" || (await open([editorUrl(APPS[editor].scheme, path, line)]))
  if (inEditor && editor !== "default") return true
  // A file no app claims, such as settings.json.bak, opens in the default text editor.
  if (!(await open([path])) && OPENER === "open") await open(["-t", path])
  return editor === "default"
}
