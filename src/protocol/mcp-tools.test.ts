import { expect, test } from "bun:test"
import type { ClientTool } from "../agent/agent.ts"
import { callClientTool } from "./mcp-tools.ts"

test("a client tool that throws answers with an error result", async () => {
  const tool: ClientTool = {
    server: "mod-x",
    name: "boom",
    description: "",
    inputSchema: {},
    annotations: null,
    run: () => Promise.reject(new Error("it broke")),
  }
  expect(await callClientTool([tool], { name: "boom" })).toEqual({
    content: [{ type: "text", text: "it broke" }],
    isError: true,
  })
})
