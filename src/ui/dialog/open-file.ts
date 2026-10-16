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

export async function openFile(path: string, line?: number): Promise<void> {
  const editor = settings.editor
  const target = editor === "default" ? path : editorUrl(APPS[editor].scheme, path, line)
  try {
    const child = Bun.spawn(["open", target], { stdout: "ignore", stderr: "pipe" })
    if ((await child.exited) !== 0) log.warn("open failed", await new Response(child.stderr).text())
  } catch (error) {
    log.warn("open failed", error)
  }
}
