import { afterAll, expect, spyOn, test } from "bun:test"
import { log } from "../../log/log.ts"
import { createSseParser, httpTransport, STREAM_FAILURE } from "./transport.ts"

const PASSWORD = "pw-never-logged-7f3a"
const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
// Non-Latin-1 and `%`: the header must be encoded to pass at all and to decode to the same path.
const DIRECTORY = "/work/çalışma 项目 100%"
const seen: { path: string; authorization: string | null; directory: string | null }[] = []

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url)
    const authorization = req.headers.get("authorization")
    const directory = req.headers.get("x-opencode-directory")
    seen.push({ path: url.pathname + url.search, authorization, directory: directory && decodeURIComponent(directory) })
    if (authorization !== BASIC)
      return Response.json({ _tag: "UnauthorizedError" }, { status: 401, headers: { "www-authenticate": "Basic" } })
    if (url.pathname === "/api/event")
      return new Response(
        `data: {"id":"e1","type":"server.connected","data":{}}\n\n: heartbeat\n\nevent: ${STREAM_FAILURE}\ndata: [{"_tag":"Die","defect":"x"}]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    if (url.pathname === "/api/experimental/client-mcp" && srv.upgrade(req)) return undefined
    return Response.json({ data: { echo: url.pathname } })
  },
  websocket: {
    open(ws) {
      ws.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
    },
    message(ws, message) {
      ws.send(`{"got":${String(message)}}`)
    },
  },
})
afterAll(() => server.stop(true))

const endpoint = (password: string) => ({
  url: `http://127.0.0.1:${server.port}`,
  auth: { type: "basic" as const, username: "opencode", password },
})

test("the SSE parser keeps data frames and their event name and skips heartbeats", () => {
  const parse = createSseParser()
  expect(parse('data: {"a":1}\r\n\r\n: heartbeat\n\nevent: x\ndata: {"b"')).toEqual([{ name: null, data: { a: 1 } }])
  expect(parse(":2}\n\ndata: not json\n\n")).toEqual([
    { name: "x", data: { b: 2 } },
    { name: null, data: "not json" },
  ])
})

test("every request, the event stream and the socket carry the auth and directory headers", async () => {
  seen.length = 0
  const transport = httpTransport(endpoint(PASSWORD), DIRECTORY)
  expect(await transport.request({ method: "GET", path: "/api/info", query: { a: "1" } })).toEqual({
    status: 200,
    body: { data: { echo: "/api/info" } },
  })

  const frames: unknown[] = []
  const failure = await (async () => {
    for await (const frame of transport.events()) frames.push(frame)
  })().then(
    () => "",
    (error: unknown) => String(error),
  )
  expect(frames).toEqual([{ id: "e1", type: "server.connected", data: {} }])
  expect(failure).toContain("the event stream failed (Die)")

  const socket = await transport.socket("yellowcode")
  const iterator = socket.frames[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize" })
  socket.send({ id: 1, result: {} })
  expect((await iterator.next()).value).toEqual({ got: { id: 1, result: {} } })
  socket.close()
  expect((await iterator.next()).done).toBe(true)

  expect(seen.map((one) => one.path)).toEqual([
    "/api/info?a=1",
    "/api/event",
    `/api/experimental/client-mcp?${new URLSearchParams({ "location[directory]": DIRECTORY, name: "yellowcode" }).toString()}`,
  ])
  expect(seen.every((one) => one.authorization === BASIC && one.directory === DIRECTORY)).toBe(true)
})

test("a 401 is logged without the password", async () => {
  const calls: unknown[][] = []
  const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(log, level).mockImplementation((...args: unknown[]) => void calls.push(args)),
  )
  const wrong = "pw-wrong-but-secret-91c2"
  try {
    const transport = httpTransport(endpoint(wrong), "/work/project")
    const reply = await transport.request({ method: "GET", path: "/api/session" })
    const events = await (async () => {
      for await (const _ of transport.events()) break
    })().then(
      () => "",
      (error: unknown) => String(error),
    )
    expect(reply).toEqual({ status: 401, body: { _tag: "UnauthorizedError" } })
    expect(events).toContain("answered 401")
    expect(calls.length).toBeGreaterThan(0)
    const logged = JSON.stringify(calls) + events
    expect(logged).toContain("401 UnauthorizedError")
    for (const secret of [wrong, Buffer.from(`opencode:${wrong}`).toString("base64")])
      expect(logged).not.toContain(secret)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})
