import type { Ask, AskOption } from "../agent/ask.ts"
import type { PeerMessage } from "./inbox.ts"

const PREFIX = "peer-"
const EVERYWHERE = "peer-everywhere-"

const option = (id: string, effect: AskOption["effect"], lasts: AskOption["lasts"], label: string): AskOption => ({
  id,
  effect,
  lasts,
  label,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
})

// A message held for the user, asked the way a permission is. Esc takes the first no, the decline.
export const peerAsk = (id: string, message: PeerMessage): Ask => ({
  id: `${PREFIX}${id}`,
  kind: "permission",
  call: null,
  tool: { name: "message", kind: "other", mcp: null },
  title: `← ${message.from.title || message.from.id} · ${message.from.agent}${message.broadcast ? " · broadcast" : ""}`,
  input: null,
  target: message.text,
  preview: null,
  writes: [],
  detail: "",
  reason: "",
  options: [
    option("run", "allow", "once", "Run it"),
    option("always", "allow", "session", "Run it, and stop asking in this session"),
    option("decline", "deny", "once", "Decline"),
  ],
  questions: null,
  plan: null,
  defaultNo: false,
  safety: false,
  by: null,
  own: null,
})

// A broadcast to every session on the machine, asked before it goes out, whatever the permission mode.
export const everywhereAsk = (id: string, text: string): Ask => ({
  ...peerAsk(id, { from: { id: "", title: "", agent: "" }, to: "", broadcast: false, text, images: [] }),
  id: `${EVERYWHERE}${id}`,
  title: "→ every session on this machine",
  options: [option("send", "allow", "once", "Send"), option("dont", "deny", "once", "Don't send")],
})

// The held message an ask is about, if it is one of ours.
export const heldOf = (askId: string): string | null =>
  askId.startsWith(PREFIX) && !askId.startsWith(EVERYWHERE) ? askId.slice(PREFIX.length) : null

export const everywhereOf = (askId: string): string | null =>
  askId.startsWith(EVERYWHERE) ? askId.slice(EVERYWHERE.length) : null
