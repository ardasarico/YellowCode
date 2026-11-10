import { expect, test } from "bun:test"
import { runShell, shellsText } from "./shell-command.ts"

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

test("a long output keeps its start and its end", () => {
  const text = shellsText([{ command: "seq", output: `${"a".repeat(20_000)}${"b".repeat(20_000)}` }])
  expect(text).toContain(`<command>seq</command>\n<output>\n${"a".repeat(15_000)}\n[10000 characters left out]\n`)
  expect(text).toContain(`${"b".repeat(15_000)}\n</output>`)
  expect(text).not.toContain("a".repeat(15_001))
})

test("a cut never splits an emoji", () => {
  const text = shellsText([
    { command: "x", output: `${"a".repeat(14_999)}😀${"b".repeat(20_000)}😀${"c".repeat(14_999)}` },
  ])
  expect(text.isWellFormed()).toBe(true)
})
