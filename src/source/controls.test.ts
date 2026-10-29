import { expect, test } from "bun:test"
import { liveProvider } from "../agents/claude/provider.ts"
import { createSession } from "../session/session.ts"
import { controlProblem, setKnobs, settings, stepModel } from "../session/settings.ts"
import { DEFAULT_MODE } from "../session/settings-file.ts"
import { createControls, SEND_DELAY_MS } from "./controls.ts"
import type { Requests } from "./requests.ts"

const LAUNCH = { mode: DEFAULT_MODE, bypass: false }

type Sent = { subtype: string; line: string; resolve: (response: unknown) => void; reject: (error: Error) => void }

// Requests that record each control request and are answered by hand.
function fakeRequests() {
  const sent: Sent[] = []
  const requests: Requests = {
    send: (build) =>
      new Promise((resolve, reject) => {
        const line = build(`t-${sent.length + 1}`)
        const subtype = /"subtype":"(\w+)"/.exec(line)?.[1] ?? ""
        sent.push({ subtype, line, resolve, reject })
      }),
    settle: () => {},
    close: () => {},
  }
  return { requests, sent }
}

const models = [
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
]
const applied = (model: string) => ({ applied: { model, effort: "high", ultracode: false } })
const later = () => Bun.sleep(SEND_DELAY_MS + 50)

function start() {
  setKnobs({ model: null, effort: null, ultracode: false })
  const { requests, sent } = fakeRequests()
  const controls = createControls({
    requests,
    provider: liveProvider(() => Promise.resolve([])),
    session: createSession(),
    launch: LAUNCH,
  })
  controls.initialized({ commands: [], models })
  const last = (subtype: string) => sent.findLast((request) => request.subtype === subtype)
  last("get_settings")?.resolve(applied("claude-opus-5-5"))
  // Shift+→, as the App does it.
  const step = () => {
    const id = stepModel(1, null)
    if (id) controls.setModel(id)
  }
  return { sent, last, controls, step }
}

test("a model change goes out once, and the refresh after it sends nothing more", async () => {
  const { sent, last, step } = start()
  await later()
  expect(settings.model).toBe("claude-opus-5-5")
  step()
  await later()
  expect(sent.filter((request) => request.subtype === "set_model")).toHaveLength(1)
  last("set_model")?.resolve(undefined)
  await Bun.sleep(1)
  last("get_settings")?.resolve(applied("claude-sonnet-5-5"))
  await later()
  expect(settings.model).toBe("claude-sonnet-5-5")
  expect(sent.map((request) => request.subtype)).toEqual([
    "get_settings",
    "file_suggestions",
    "set_model",
    "get_settings",
  ])
})

test("a refused model change shows claude's model again and says why", async () => {
  const { last, step } = start()
  await later()
  step()
  await later()
  last("set_model")?.reject(new Error("Model 'sonnet' not found"))
  await Bun.sleep(1)
  expect(controlProblem()?.text).toBe("Cannot switch the model: Model 'sonnet' not found")
  last("get_settings")?.resolve(applied("claude-opus-5-5"))
  await Bun.sleep(1)
  expect(settings.model).toBe("claude-opus-5-5")
})

test("only the permission mode stepping stops on goes out, and bypassPermissions without the flag waits for a restart", async () => {
  const { sent, controls } = start()
  const pick = (mode: string) => controls.setMode(mode)
  const modes = () =>
    sent
      .filter((request) => request.subtype === "set_permission_mode")
      .map(({ line }) => /"mode":"(\w+)"/.exec(line)?.[1])
  pick("plan")
  pick("bypassPermissions")
  pick("dontAsk")
  await later()
  expect(modes()).toEqual(["dontAsk"])
  expect(controlProblem()?.text).not.toBe("bypassPermissions applies from the next start")
  pick("default")
  pick("bypassPermissions")
  await later()
  expect(modes()).toEqual(["dontAsk"])
  expect(controlProblem()?.text).toBe("bypassPermissions applies from the next start")
})

test("the controls of a claude that was replaced send nothing more, and its late replies change nothing", async () => {
  setKnobs({ model: null, effort: null, ultracode: false })
  const { requests, sent } = fakeRequests()
  const controls = createControls({
    requests,
    provider: liveProvider(() => Promise.resolve([])),
    session: createSession(),
    launch: LAUNCH,
  })
  controls.initialized({ commands: [], models })
  controls.dispose()
  sent.find((request) => request.subtype === "get_settings")?.resolve(applied("claude-sonnet-5-5"))
  await Bun.sleep(1)
  expect(settings.model).toBeNull()
  controls.setModel("claude-opus-5-5")
  await later()
  expect(sent.map((request) => request.subtype)).toEqual(["get_settings", "file_suggestions"])
})
