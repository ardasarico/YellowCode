import { expect, test } from "bun:test"
import { createClaudeSource } from "./claude.ts"

// Stands in for claude: echoes each line, ends when its input closes, and exits with code 3 on "quit".
const ECHO = `
for await (const line of console) {
  if (line === "quit") {
    console.error("boom")
    process.exit(3)
  }
  console.log(line)
}
`

test("gives each sent line before its reply and reports how the process exited", async () => {
  const source = createClaudeSource(process.cwd(), () => false, ["bun", "-e", ECHO])
  const events = source.events[Symbol.asyncIterator]()
  const next = async () => {
    const result = await events.next()
    return result.done ? null : `${result.value.dir} ${result.value.line}`
  }

  source.send("hello")
  expect([await next(), await next()]).toEqual(["out hello", "in hello"])
  source.send("quit")
  expect([await next(), await next()]).toEqual(["out quit", null])
  expect(await source.exited).toEqual({ code: 3, signal: null, stderr: ["boom"], closed: false })
})

test("close ends an idle process by closing its input", async () => {
  const source = createClaudeSource(process.cwd(), () => false, ["bun", "-e", ECHO])
  source.close()
  expect(await source.exited).toEqual({ code: 0, signal: null, stderr: [], closed: true })
})

test("close stops a process in the middle of a turn", async () => {
  const source = createClaudeSource(process.cwd(), () => true, ["bun", "-e", "setInterval(() => {}, 1000)"])
  source.close()
  expect(await source.exited).toMatchObject({ signal: "SIGTERM", closed: true })
})
