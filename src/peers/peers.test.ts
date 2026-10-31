import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionMessage, sessionMessage } from "./envelope.ts"
import { startPeers } from "./host.ts"
import { openInbox, type PeerMessage } from "./inbox.ts"
import { deliver } from "./outbox.ts"
import { sameProject } from "./project.ts"
import { listPeers, openRegistry, type PeerRecord } from "./registry.ts"
import { callPeerTool, type PeerContext, readResultLine } from "./tools.ts"

const temp = mkdtempSync(join(tmpdir(), "yc-peers-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const state = {
  session: "s1",
  agent: "claude",
  title: "t",
  cwd: "/w",
  project: "/w",
  model: "m",
  status: "idle",
  hidden: false,
} as const

test("lists live records and prunes dead ones", async () => {
  const dir = join(temp, "registry")
  const registry = openRegistry(state, dir)
  const dead = Bun.spawn(["true"])
  await dead.exited
  writeFileSync(join(dir, `${dead.pid}.json`), JSON.stringify({ ...state, pid: dead.pid, socket: "x" }))
  writeFileSync(join(dir, `${dead.pid}.sock`), "")

  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(listPeers(dir).map((peer) => peer.pid)).toEqual([process.pid])
  expect(existsSync(join(dir, `${dead.pid}.json`))).toBe(false)
  expect(existsSync(join(dir, `${dead.pid}.sock`))).toBe(false)

  registry.update({ status: "busy" })
  expect(listPeers(dir)[0]?.status).toBe("busy")
  registry.remove()
  expect(listPeers(dir)).toEqual([])
})

test("delivers to the current session and refuses stale ids and gone sockets", async () => {
  const socket = join(temp, "inbox.sock")
  const got: PeerMessage[] = []
  const inbox = await openInbox(socket, (message) => {
    if (message.to !== "s1") return { error: "not-active" }
    got.push(message)
    return { ok: "run" }
  })
  const message: PeerMessage = {
    from: { id: "s0", title: "a", agent: "opencode" },
    to: "s1",
    broadcast: false,
    text: "hi",
    images: [{ mediaType: "image/png", base64: "x".repeat(4_000_000) }],
  }

  expect(await deliver(socket, message)).toEqual({ ok: "run" })
  expect(got[0]?.images[0]?.base64.length).toBe(4_000_000)
  expect(await deliver(socket, { ...message, to: "old" })).toEqual({ error: "not-active" })
  inbox.close()
  rmSync(socket, { force: true })
  expect(await deliver(socket, message)).toEqual({ error: "not-active" })
})

test("a record whose live pid belongs to another process is deleted once its socket refuses", async () => {
  const dir = join(temp, "reused")
  openRegistry(state, dir).remove()
  const other = Bun.spawn(["sleep", "10"])
  const socket = join(dir, `${other.pid}.sock`)
  writeFileSync(join(dir, `${other.pid}.json`), JSON.stringify({ ...state, pid: other.pid, socket }))

  expect(listPeers(dir)).toHaveLength(1)
  await deliver(socket, {
    from: { id: "s0", title: "a", agent: "claude" },
    to: "s1",
    broadcast: false,
    text: "",
    images: [],
  })
  expect(listPeers(dir)).toEqual([])
  other.kill()
})

test("two sessions share a project when either folder holds the other", () => {
  expect(sameProject("/r", "/r/client")).toBe(true)
  expect(sameProject("/r/client", "/r")).toBe(true)
  expect(sameProject("/r", "/rx")).toBe(false)
})

test("reads back the envelope it writes", () => {
  const plain = { id: "s0", title: 'say "hi"\nnow', agent: "claude", broadcast: false, text: "line\n\nmore" }
  expect(readSessionMessage(sessionMessage(plain))).toEqual({ ...plain, title: "say hi now" })
  const broadcast = { ...plain, title: "a", broadcast: true }
  expect(readSessionMessage(sessionMessage(broadcast))).toEqual(broadcast)
  expect(readSessionMessage("<session-message>hi")).toBeNull()
})

const peer = (session: string | null, pid: number, hidden = false): PeerRecord => ({
  ...state,
  session,
  pid,
  hidden,
  socket: "",
})

function context(over: Partial<PeerContext> = {}) {
  const sent: PeerMessage[] = []
  const value: PeerContext = {
    self: () => ({ id: "me", title: "mine", agent: "claude", cwd: temp, project: "/w" }),
    peers: () => [
      peer("me", process.pid),
      peer("a", 1),
      peer("h", 2, true),
      peer(null, 3),
      { ...peer("far", 4), project: "/elsewhere" },
    ],
    deliver: (_record, message) => {
      sent.push(message)
      return Promise.resolve({ ok: message.to === "a" ? "run" : "queued" })
    },
    loadImage: (path) => Promise.resolve(path.endsWith(".png") ? { mediaType: "image/png", base64: "aW1n" } : null),
    diff: () => Promise.resolve("+added"),
    broadcastFrom: () => null,
    confirm: () => Promise.resolve(false),
    ...over,
  }
  return { value, sent }
}

test("lists the others, sends with attachments and refuses bad paths", async () => {
  const { value, sent } = context()
  const list = await callPeerTool("list", {}, value)
  expect(list.text.split("\n")).toEqual([
    "This session: me",
    "",
    "This project:",
    "a  t · claude m · /w · idle",
    "",
    "Other projects:",
    "far  t · claude m · /w · idle",
  ])

  writeFileSync(join(temp, "notes.md"), "")
  const input = { to: "a", message: "do it", files: ["notes.md"], images: ["shot.png"], diff: true }
  expect(await callPeerTool("send", input, value)).toEqual({
    text: "t (claude, a): delivered, it runs your message now.",
    isError: false,
  })
  expect(readResultLine("t (claude, a): delivered, it runs your message now.")).toEqual({
    title: "t",
    agent: "claude",
    id: "a",
    status: "delivered, it runs your message now.",
  })
  expect(sent[0]?.text).toBe(
    `do it\n\nFiles:\n- ${join(temp, "notes.md")}\n\nDiff of ${temp}:\n\`\`\`diff\n+added\n\`\`\``,
  )
  expect(sent[0]?.images).toEqual([{ mediaType: "image/png", base64: "aW1n" }])

  expect((await callPeerTool("send", { ...input, files: ["gone.md"] }, value)).isError).toBe(true)
  expect((await callPeerTool("send", { ...input, images: ["x.txt"] }, value)).isError).toBe(true)
  expect(await callPeerTool("send", { to: "zz", message: "x" }, value)).toEqual({
    text: "zz is not active.",
    isError: true,
  })
  expect(sent.length).toBe(1)
})

test("a turn handling a broadcast writes only back to its sender", async () => {
  const { value, sent } = context({ broadcastFrom: () => "a" })
  expect((await callPeerTool("broadcast", { message: "x" }, value)).isError).toBe(true)
  expect((await callPeerTool("send", { to: "h", message: "x" }, value)).isError).toBe(true)
  expect((await callPeerTool("send", { to: "a", message: "x" }, value)).isError).toBe(false)

  const free = context()
  expect((await callPeerTool("broadcast", { message: "news" }, free.value)).text).toBe(
    "t (claude, a): delivered, it runs your message now.",
  )
  expect(free.sent.map((message) => [message.to, message.broadcast])).toEqual([["a", true]])
  expect((await callPeerTool("broadcast", { message: "off", everywhere: true }, free.value)).isError).toBe(true)
  const agreed = context({ confirm: () => Promise.resolve(true) })
  await callPeerTool("broadcast", { message: "off", everywhere: true }, agreed.value)
  expect(agreed.sent.map((message) => message.to)).toEqual(["a", "far"])
  expect(sent.length).toBe(1)
})

const peerMessage = (text: string, to = "s1", broadcast = false): PeerMessage => ({
  from: { id: "b", title: "", agent: "claude" },
  to,
  broadcast,
  text,
  images: [],
})

test("a busy session runs its messages one by one, each in its own idle moment", async () => {
  const dir = join(temp, "host")
  const host = await startPeers("/w", { ...state, status: "busy" }, dir)
  const ran: string[] = []
  host.sendWith((message) => {
    ran.push(message.text)
    return true
  })
  const socket = join(dir, `${process.pid}.sock`)

  expect(await deliver(socket, peerMessage("one", "s1", true))).toEqual({ ok: "queued" })
  expect(await deliver(socket, peerMessage("two"))).toEqual({ ok: "queued" })
  expect(await deliver(socket, peerMessage("old", "s0"))).toEqual({ error: "not-active" })
  host.update({ status: "idle" })
  host.update({ status: "idle" })
  expect(ran).toEqual(["one"])
  host.update({ status: "busy" })
  const tools = Object.fromEntries(host.tools.map((tool) => [tool.name, tool]))
  expect((await tools["broadcast"]?.run({ message: "x" }))?.text).toContain("broadcast from b")
  host.update({ status: "idle" })
  expect(ran).toEqual(["one", "two"])

  host.update({ status: "busy" })
  expect(await deliver(socket, peerMessage("three"))).toEqual({ ok: "queued" })
  host.update({ session: "s2" })
  host.update({ status: "idle" })
  expect(ran).toEqual(["one", "two"])
  const asked: string[] = []
  host.holdWith((id) => {
    asked.push(id)
    return true
  })
  expect(await deliver(socket, peerMessage("five", "s2"))).toEqual({ ok: "held" })
  expect(await deliver(socket, peerMessage("six", "s2"))).toEqual({ ok: "held" })
  host.release(asked[0] ?? "", false)
  host.release(asked[1] ?? "", true)
  expect(ran).toEqual(["one", "two", "six"])
  host.update({ hidden: true })
  expect(await deliver(socket, peerMessage("four", "s2"))).toEqual({ error: "hidden" })
  host.close()
  expect(existsSync(socket)).toBe(false)
})
