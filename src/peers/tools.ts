import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import { z } from "zod"
import type { ClientTool, PromptImage } from "../agent/agent.ts"
import type { LoadImage } from "../input/draft.ts"
import { gitEnv, runGit } from "../rewind/common.ts"
import { oneLine } from "../session/agent-message.ts"
import type { PeerFrom } from "./envelope.ts"
import type { PeerAnswer, PeerMessage } from "./inbox.ts"
import { sameProject } from "./project.ts"
import type { PeerRecord } from "./registry.ts"

const MAX_DIFF_CHARS = 256 * 1024

// The tools reach every agent as client tools of this server, beside the mods' servers.
export const PEER_SERVER = "yellowcode-sessions"

export type PeerContext = {
  // null until the agent has started its session.
  self(): (PeerFrom & { cwd: string; project: string }) | null
  peers(): PeerRecord[]
  deliver(record: PeerRecord, message: PeerMessage): Promise<PeerAnswer>
  loadImage: LoadImage
  diff(cwd: string): Promise<string>
  // The sender of the broadcast this turn handles, if any.
  broadcastFrom(): string | null
  // Asks the user whether a broadcast to every session on the machine may go out.
  confirm(message: string): Promise<boolean>
}

export type PeerToolResult = { text: string; isError: boolean }

const ATTACHMENTS = {
  files: {
    type: "array",
    items: { type: "string" },
    description: "Paths of files or folders the other session should look at, absolute or relative to this project.",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description: "Paths of PNG, JPEG, GIF or WebP images, given to the other session's model as images.",
  },
  diff: { type: "boolean", description: "Attach this project's current `git diff HEAD`." },
}

export const PEER_TOOLS = [
  {
    name: "list",
    description:
      "List the other YellowCode sessions open on this machine, with any agent, those of this project first: id, " +
      "title, directory, agent, model and whether each is busy or idle. Use it before `send` to find a session's id.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "send",
    description:
      "Send a message to another open YellowCode session, for example to hand it a piece of work. It runs there as " +
      "a new turn (after the current one if that session is busy). You do not wait: any reply arrives later as a " +
      "message from that session. Write the message so it stands alone; the other session has none of your context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "message"],
      properties: {
        to: { type: "string", description: "The session id from `list`." },
        message: { type: "string" },
        ...ATTACHMENTS,
      },
    },
  },
  {
    name: "broadcast",
    description:
      "Send one message to every other open YellowCode session of this project, for news they all need (a changed " +
      "API, a shared file moved). Each runs it as a new turn and may only reply to you.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string" },
        ...ATTACHMENTS,
        everywhere: {
          type: "boolean",
          description:
            "Reach every session on this machine, in every project, for news that concerns them all, such as the " +
            "machine shutting down. YellowCode asks the user first, every time.",
        },
      },
    },
  },
]

const SEND = z.object({
  to: z.string().min(1),
  message: z.string().min(1),
  files: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
  diff: z.boolean().optional(),
})
const BROADCAST = SEND.omit({ to: true }).extend({ everywhere: z.boolean().optional() })

const error = (text: string): PeerToolResult => ({ text, isError: true })

const others = (context: PeerContext) =>
  context.peers().filter((peer) => peer.pid !== process.pid && peer.session !== null)

const listLine = (peer: PeerRecord) =>
  `${peer.session}  ${peer.title || basename(peer.cwd)} · ${[peer.agent, peer.model].filter(Boolean).join(" ")} · ${peer.cwd} · ${peer.status}`

const group = (peers: PeerRecord[]) => (peers.length > 0 ? peers.map(listLine) : ["none"])

function listText(context: PeerContext, self: PeerFrom & { project: string }): string {
  const shown = others(context).filter((peer) => !peer.hidden)
  const here = shown.filter((peer) => sameProject(peer.project, self.project))
  const elsewhere = shown.filter((peer) => !sameProject(peer.project, self.project))
  return [
    `This session: ${self.id}`,
    "",
    "This project:",
    ...group(here),
    "",
    "Other projects:",
    ...group(elsewhere),
  ].join("\n")
}

type Body = { text: string; images: PromptImage[] }

async function bodyOf(input: z.infer<typeof BROADCAST>, cwd: string, context: PeerContext): Promise<Body | string> {
  const parts = [input.message]
  const files = (input.files ?? []).map((path) => resolve(cwd, path))
  const missing = files.find((path) => !existsSync(path))
  if (missing) return `There is no file or folder at ${missing}.`
  if (files.length > 0) parts.push(["Files:", ...files.map((path) => `- ${path}`)].join("\n"))
  if (input.diff) {
    let diff: string
    try {
      diff = await context.diff(cwd)
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason)
    }
    parts.push(`Diff of ${cwd}:\n\`\`\`diff\n${diff}\n\`\`\``)
  }
  const images: PromptImage[] = []
  for (const path of input.images ?? []) {
    const full = resolve(cwd, path)
    let image: PromptImage | null
    try {
      // oxlint-disable-next-line no-await-in-loop
      image = await context.loadImage(full)
    } catch (reason) {
      return `${full}: ${reason instanceof Error ? reason.message : String(reason)}`
    }
    if (!image) return `${full} could not be read as an image.`
    images.push(image)
  }
  return { text: parts.join("\n\n"), images }
}

// One line per target: `<title> (<agent>, <id>): <status>`, which the chat reads back with readResultLine.
function answerText(peer: PeerRecord, answer: PeerAnswer): string {
  const name = `${oneLine(peer.title) || basename(peer.cwd)} (${peer.agent}, ${peer.session})`
  if ("error" in answer) return `${name}: ${answer.error === "hidden" ? "takes no messages." : "not active."}`
  if (answer.ok === "run") return `${name}: delivered, it runs your message now.`
  if (answer.ok === "queued") return `${name}: delivered, it runs your message once its current turn ends.`
  return `${name}: delivered, it waits for its user to approve your message.`
}

const RESULT_LINE = /^(.*) \(([\w-]+), ([^)]+)\): (.+)$/

export function readResultLine(line: string): { title: string; agent: string; id: string; status: string } | null {
  const [, title = "", agent = "", id = "", status = ""] = RESULT_LINE.exec(line) ?? []
  return agent ? { title, agent, id, status } : null
}

type Self = PeerFrom & { cwd: string; project: string }

const fromOf = ({ id, title, agent }: Self): PeerFrom => ({ id, title, agent })

async function send(input: unknown, self: Self, context: PeerContext): Promise<PeerToolResult> {
  const parsed = SEND.safeParse(input)
  if (!parsed.success) return error(`Invalid input: ${parsed.error.message}`)
  const { to } = parsed.data
  const from = context.broadcastFrom()
  if (from !== null && to !== from)
    return error(`This turn handles a broadcast from ${from}; it may only write back to ${from}.`)
  const record = others(context).find((peer) => peer.session === to)
  if (!record) return error(`${to} is not active.`)
  const body = await bodyOf(parsed.data, self.cwd, context)
  if (typeof body === "string") return error(body)
  const answer = await context.deliver(record, { from: fromOf(self), to, broadcast: false, ...body })
  return { text: answerText(record, answer), isError: "error" in answer }
}

async function broadcast(input: unknown, self: Self, context: PeerContext): Promise<PeerToolResult> {
  const parsed = BROADCAST.safeParse(input)
  if (!parsed.success) return error(`Invalid input: ${parsed.error.message}`)
  const from = context.broadcastFrom()
  if (from !== null) return error(`This turn handles a broadcast from ${from}; it may only write back to ${from}.`)
  const everywhere = parsed.data.everywhere === true
  const targets = others(context).filter(
    (peer) => !peer.hidden && (everywhere || sameProject(peer.project, self.project)),
  )
  if (targets.length === 0)
    return error(
      everywhere ? "No other open YellowCode sessions." : "No other open YellowCode sessions in this project.",
    )
  const body = await bodyOf(parsed.data, self.cwd, context)
  if (typeof body === "string") return error(body)
  if (everywhere && !(await context.confirm(parsed.data.message)))
    return error("The user did not let this message go to every session.")
  const answers = await Promise.all(
    targets.map((peer) =>
      context.deliver(peer, { from: fromOf(self), to: peer.session ?? "", broadcast: true, ...body }),
    ),
  )
  const lines = targets.map((peer, index) => answerText(peer, answers[index] ?? { error: "not-active" }))
  return { text: lines.join("\n"), isError: answers.every((answer) => "error" in answer) }
}

export async function callPeerTool(name: string, input: unknown, context: PeerContext): Promise<PeerToolResult> {
  const self = context.self()
  if (!self) return error("This session has not started yet.")
  if (name === "list") return { text: listText(context, self), isError: false }
  if (name === "send") return send(input, self, context)
  if (name === "broadcast") return broadcast(input, self, context)
  return error(`Unknown tool ${name}.`)
}

export const peerClientTools = (context: PeerContext): ClientTool[] =>
  PEER_TOOLS.map((tool) => ({
    server: PEER_SERVER,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnly: tool.name === "list", destructive: false },
    run: async (input) => {
      const result = await callPeerTool(tool.name, input, context)
      return { text: result.text, error: result.isError }
    },
  }))

export async function gitDiff(cwd: string): Promise<string> {
  const run = await runGit(["diff", "HEAD", "--no-color", "--no-ext-diff"], {
    cwd,
    env: gitEnv({}),
    timeoutMs: 10_000,
  })
  if (run.code !== 0) throw new Error(`git diff failed in ${cwd}: ${run.stderr || "not a git repository"}`)
  const text = new TextDecoder().decode(run.stdout).trimEnd()
  if (text === "") throw new Error(`There is no git diff in ${cwd}.`)
  if (text.length > MAX_DIFF_CHARS) throw new Error(`The git diff in ${cwd} is too large to attach.`)
  return text
}
