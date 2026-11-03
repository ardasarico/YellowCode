import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { z } from "zod"
import type { ClientTool } from "../agent/agent.ts"
import { parseJson } from "../json.ts"
import { type ModEntry, modClientTools } from "../mods/host.ts"
import { addTool } from "../mods/registry.ts"
import { serveModTools, syncModServers } from "./mod-tools.ts"
import type { Requests } from "./requests.ts"

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
      modClientTools(),
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
    inputSchema: { type: "object" },
    run: (input) => `echo ${String(input.text)}`,
  })
  const broken = addTool({
    mod: "demo",
    name: "broken",
    description: "Throws",
    inputSchema: { type: "object" },
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

const tool = (name: string): ClientTool => ({
  server: "mod-m",
  name,
  description: "",
  inputSchema: {},
  annotations: null,
  run: () => Promise.resolve({ text: "", error: false }),
})

test("a mod turned off while its tools leave one by one is not added back to Claude", async () => {
  const sent: string[][] = []
  const requests: Requests = {
    send: (build) => {
      const line = parseJson(build("r"))
      const servers = z
        .object({ request: z.object({ servers: z.record(z.string(), z.unknown()) }) })
        .parse(line.ok ? line.value : null).request.servers
      sent.push(Object.keys(servers))
      return Promise.resolve({})
    },
    settle: () => {},
    close: () => {},
  }
  const [status, setStatus] = createSignal<ModEntry["status"]>("on")
  const [tools, setTools] = createSignal([tool("a"), tool("b")])
  const host = {
    get entries() {
      const entry: ModEntry = {
        id: "m",
        folder: "/mods/m",
        manifest: null,
        status: status(),
        source: "local",
        problem: null,
        error: null,
        loadMs: null,
        settings: null,
      }
      return [entry]
    },
    servers: () => ({}),
  }
  // oxlint-disable-next-line solid/reactivity -- syncModServers reads it inside its own effect
  const stop = syncModServers(requests, host, tools)
  setTools([tool("b")])
  setStatus("off")
  setTools([])
  await new Promise((resolve) => setTimeout(resolve, 10))
  stop()
  expect(sent.at(-1)).not.toContain("mod-m")
})
