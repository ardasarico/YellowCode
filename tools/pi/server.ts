// Starts `pi --mode rpc` in an isolated root and proves it never touches the user's pi folder or the network.
import { existsSync, realpathSync } from "node:fs"
import { appendFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { stdioTransport, type Transport } from "../../src/agents/codex/transport.ts"
import { finder, kill, look, snapshot } from "../codex/server.ts"
import { piEnv, type Root } from "./env.ts"

const USER_AGENT_DIR = join(homedir(), ".pi", "agent")
// mtime only: none of these is read. The folder itself is left out: pi's launcher makes and removes a lock under it on
// every start, the user's own pi included.
const WATCHED = ["settings.json", "models.json", "auth.json", "sessions"].map((name) => join(USER_AGENT_DIR, name))

export type Running = {
  transport: Transport
  pid: number
  // Stops our processes, checks the user's pi folder is as before and nothing left the machine, and removes the root
  // (unless kept). Returns the problems found.
  stop(): Promise<string[]>
}

export function startPi(root: Root, proxy: string, args: string[] = [], options: { keep?: boolean } = {}): Running {
  if (!root.root.startsWith("/private/tmp/yc-pi-")) throw new Error(`unexpected root ${root.root}`)
  if (existsSync(USER_AGENT_DIR) && realpathSync(root.agent) === realpathSync(USER_AGENT_DIR))
    throw new Error("the isolated agent folder is the user's own")
  const before = WATCHED.map(snapshot)
  const stderr = join(root.root, "stderr.log")
  const transport = stdioTransport({
    command: ["pi", "--mode", "rpc", ...args],
    cwd: root.project,
    env: piEnv(root, proxy),
    onStderr: (text) => void appendFile(stderr, text),
  })
  const ours = finder(transport.pid, root.root)
  const problems = new Set<string>()
  const watch = setInterval(() => look(ours, problems), 300)

  return {
    transport,
    pid: transport.pid,
    async stop() {
      clearInterval(watch)
      look(ours, problems)
      await transport.close()
      const left = await kill(ours)
      if (left.length > 0) problems.add(`processes ${left.join(", ")} in ${root.root} are still running`)
      if (WATCHED.map(snapshot).join() !== before.join()) problems.add("the user's ~/.pi/agent changed")
      if (!options.keep) await rm(root.root, { recursive: true, force: true })
      return [...problems]
    },
  }
}
