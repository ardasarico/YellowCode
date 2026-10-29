import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDriver } from "../../../tools/codex/driver.ts"
import { isRaw } from "../../../tools/codex/scenario.ts"
import { scenarios } from "../../../tools/codex/scenarios/index.ts"
import { prompt, startThread } from "../../../tools/codex/scenarios/raw-hello.ts"
import { readFixture } from "./fixture.ts"
import { replayTransport } from "./replay-transport.ts"
import { rpcClient } from "./transport.ts"

const fixture = (name: string) =>
  readFixture(readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "codex", `${name}.jsonl`), "utf8"))

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (reason: unknown) => String(reason),
  )

test("each recorded scenario replays its own steps with every message used", async () => {
  for (const scenario of scenarios.filter(isRaw)) {
    const transport = replayTransport(fixture(scenario.name))
    const driver = createDriver(transport, { directory: "<root>/project", timeoutMs: 2_000 })
    // oxlint-disable-next-line no-await-in-loop -- one replay at a time
    await scenario.steps(driver)
    // oxlint-disable-next-line no-await-in-loop -- one replay at a time
    await transport.close()
    expect([scenario.name, transport.unused().length]).toEqual([scenario.name, 0])
  }
})

test("an unmatched request names where it differs from the closest recorded one", async () => {
  const rpc = rpcClient(replayTransport(fixture("raw-hello")))
  expect(await failure(rpc.request("thread/start", { cwd: "/elsewhere" }))).toContain(
    'nothing recorded for thread/start; closest differs at params.cwd: asked "/elsewhere", recorded "<root>/project"; ' +
      'params.historyMode: asked nothing, recorded "paginated"',
  )
})

test("an answer to a server request must be the recorded one", async () => {
  const transport = replayTransport(fixture("raw-shell"))
  const d = createDriver(transport, { directory: "<root>/project", timeoutMs: 2_000 })
  const threadId = await startThread(d, { approvalPolicy: "untrusted" })
  await d.request("turn/start", prompt(threadId, "SHELL make a file"))
  const ask = await d.until("item/commandExecution/requestApproval")
  expect(() => d.respond(ask.type === "request" ? ask.id : -1, { decision: "decline" })).toThrow(
    'result.decision: asked "decline", recorded "accept"',
  )
  await transport.close()
})
