import { z } from "zod"
import { parseJson } from "../../src/protocol/json.ts"

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const initLine = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  plugins: z.unknown(),
  messaging_socket_path: z.string().optional(),
})

type ScrubPaths = { workDirs: string[]; home: string; username: string; uid: number }

function rewriteInit(line: string): string {
  const json = parseJson(line)
  if (!json.ok) return line
  const init = initLine.safeParse(json.value)
  if (!init.success) return line
  const rewritten = { ...init.data, plugins: [] }
  if (rewritten.messaging_socket_path !== undefined) rewritten.messaging_socket_path = "/tmp/cc-socks/0.sock"
  return JSON.stringify(rewritten)
}

export function scrub(line: string, paths: ScrubPaths): string {
  let out = line
  for (const dir of paths.workDirs) {
    out = out.replaceAll(dir.replaceAll("/", "-"), "-Users-user-project")
    out = out.replaceAll(dir, "/Users/user/project")
  }
  for (const prefix of ["/private/tmp", "/tmp"])
    out = out.replaceAll(`${prefix}/claude-${paths.uid}`, "/tmp/claude-user")
  out = out.replaceAll(paths.home, "/Users/user").replaceAll(paths.username, "user").replace(EMAIL, "user@example.com")
  return rewriteInit(out)
}
