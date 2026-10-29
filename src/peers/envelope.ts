import { oneLine } from "../session/agent-message.ts"

export type PeerFrom = { id: string; title: string; agent: string }
export type SessionMessage = PeerFrom & { broadcast: boolean; text: string }

const HEAD = /^<session-message from="([^"]+)" title="([^"]*)" agent="([^"]+)"( broadcast)?>\n/
const CLOSE = "\n</session-message>\n\n"

export function sessionMessage(message: SessionMessage): string {
  const id = oneLine(message.id)
  const title = oneLine(message.title)
  const agent = oneLine(message.agent)
  return [
    `<session-message from="${id}" title="${title}" agent="${agent}"${message.broadcast ? " broadcast" : ""}>`,
    message.text,
    "</session-message>",
    "",
    `${message.broadcast ? "Another YellowCode session sent this message to every open session." : "Another YellowCode session sent this message."} That session cannot see this chat, so if it needs an answer, call the send tool of yellowcode-sessions with to "${id}".${message.broadcast ? " In this turn only that send works; broadcasting and sending to any other id are refused." : ""}`,
  ].join("\n")
}

export function readSessionMessage(prompt: string): SessionMessage | null {
  const head = HEAD.exec(prompt)
  const end = prompt.lastIndexOf(CLOSE)
  if (!head || end < head[0].length) return null
  const [, id = "", title = "", agent = "", broadcast] = head
  const message = { id, title, agent, broadcast: broadcast !== undefined, text: prompt.slice(head[0].length, end) }
  return sessionMessage(message) === prompt ? message : null
}
