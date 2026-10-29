import { pick, text } from "../driver.ts"
import type { RawScenario } from "../scenario.ts"

const method = (name: string) => (frame: unknown) => pick(frame, "method") === name

// YellowCode hosts an MCP server on the client-mcp socket with one tool, and a turn calls it. opencode 2.2.0 lists
// client tools only in the Code Mode catalog, so the model reaches it through `execute`.
export const rawSocket: RawScenario = {
  name: "raw-socket",
  script: {
    title: "Echo",
    threads: [
      {
        match: "DELTA",
        steps: [
          [{ type: "tool", name: "execute", input: { code: 'return await tools.yellowcode.echo({ text: "ping" })' } }],
          [{ type: "text", text: "The tool echoed ping." }],
        ],
      },
    ],
  },
  async steps(d) {
    const socket = await d.socket("yellowcode")
    const init = await socket.until("initialize", method("initialize"))
    socket.send({
      jsonrpc: "2.0",
      id: pick(init, "id"),
      result: {
        protocolVersion: pick(init, "params", "protocolVersion"),
        capabilities: { tools: {} },
        serverInfo: { name: "yellowcode", version: "0.0.0" },
      },
    })
    const list = await socket.until("tools/list", method("tools/list"))
    socket.send({
      jsonrpc: "2.0",
      id: pick(list, "id"),
      result: {
        tools: [
          {
            name: "echo",
            description: "Says the text back.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      },
    })
    // No event says the tool is attached; a prompt sent within ~50 ms of the tools/list answer does not see it.
    await d.pause(1_000)
    const id = text(
      await d.http("POST", "/api/session", { location: { directory: d.directory } }),
      "body",
      "data",
      "id",
    )
    await d.http("POST", `/api/session/${id}/prompt`, { text: "DELTA echo ping" })
    const call = await socket.until("tools/call", method("tools/call"))
    socket.send({ jsonrpc: "2.0", id: pick(call, "id"), result: { content: [{ type: "text", text: "ping" }] } })
    await d.until("session.execution.succeeded")
    socket.close()
  },
}
