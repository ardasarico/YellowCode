import { expect, test } from "bun:test"
import { rpcClient, stdioTransport, type Incoming } from "./transport.ts"

// Answers `echo`, fails `boom`, asks the client something on `ask`, and exits on `quit` without answering.
const FAKE = `
for await (const chunk of Bun.stdin.stream()) {
  for (const line of new TextDecoder().decode(chunk).split("\\n").filter(Boolean)) {
    const msg = JSON.parse(line)
    const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
    if (msg.method === "echo") say({ id: msg.id, result: msg.params })
    if (msg.method === "boom") say({ id: msg.id, error: { code: -32600, message: "no" } })
    if (msg.method === "ask") { console.error("not protocol"); say({ id: 7, method: "item/tool/call", params: {} }) }
    if (msg.method === "quit") process.exit(3)
  }
}
`

test("requests pair with responses, server requests arrive, and an exit fails what is pending", async () => {
  const rpc = rpcClient(stdioTransport({ command: [process.execPath, "-e", FAKE], cwd: "/", env: {} }))
  const seen: Incoming[] = []
  const reading = (async () => {
    for await (const message of rpc.incoming) seen.push(message)
  })()
  expect(await rpc.request("echo", { a: 1 })).toEqual({ a: 1 })
  expect(await rpc.request("boom").catch((error: unknown) => String(error))).toContain("boom: no (-32600)")
  rpc.notify("ask")
  const pending = rpc.request("quit").catch((error: unknown) => String(error))
  expect(await pending).toContain("quit: codex app-server ended")
  await reading
  expect(seen).toEqual([{ type: "request", id: 7, method: "item/tool/call", params: {} }])
  expect(await rpc.exited).toEqual({ code: 3, signal: null })
})
