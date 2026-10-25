import { expect, test } from "bun:test"
import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { addTool } from "../mods/registry.ts"
import { serveModTools } from "./mod-tools.ts"

function serve(method: string, params: unknown) {
  return new Promise<unknown>((resolve) => {
    const request = {
      subtype: "mcp_message" as const,
      server_name: "mod-demo",
      message: { jsonrpc: "2.0" as const, id: 1, method, params },
    }
    serveModTools(
      (line) => {
        const parsed = parseJson(line)
        resolve(parsed.ok ? parsed.value : null)
      },
      "req",
      request,
    )
  })
}

const reply = z.object({
  response: z.object({ response: z.object({ mcp_response: z.object({ result: z.unknown() }) }) }),
})
const result = (line: unknown) => reply.parse(line).response.response.mcp_response.result

test("a mod's tools are listed and called, and a throwing tool is an error Claude reads", async () => {
  const echo = addTool({
    mod: "demo",
    name: "echo",
    description: "Echo",
    input: { type: "object" },
    run: (input) => `echo ${String(input.text)}`,
  })
  const broken = addTool({
    mod: "demo",
    name: "broken",
    description: "Throws",
    input: { type: "object" },
    run: () => {
      throw new Error("no luck")
    },
  })

  expect(result(await serve("tools/list", {}))).toEqual({
    tools: [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      { name: "broken", description: "Throws", inputSchema: { type: "object" } },
    ],
  })
  expect(result(await serve("tools/call", { name: "echo", arguments: { text: "hi" } }))).toEqual({
    content: [{ type: "text", text: "echo hi" }],
    isError: false,
  })
  expect(result(await serve("tools/call", { name: "broken", arguments: {} }))).toEqual({
    content: [{ type: "text", text: "no luck" }],
    isError: true,
  })
  echo()
  broken()
})
