import { expect, test } from "bun:test"
import { runShell } from "./shell-command.ts"

const running = async (pattern: string) => (await Bun.spawn(["pgrep", "-f", pattern]).exited) === 0

test("stopping a command ends the commands it started", async () => {
  const run = runShell("sleep 31.7 | cat", process.cwd(), () => {})
  await Bun.sleep(200)
  expect(await running("sleep 31.7")).toBe(true)
  run.stop()
  const ended = await Promise.race([run.done, Bun.sleep(3000).then(() => null)])
  expect(ended?.stopped).toBe(true)
  await Bun.sleep(300)
  expect(await running("sleep 31.7")).toBe(false)
})
