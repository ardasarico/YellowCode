export type AgentMessage = { id: string; name: string; text: string }

const HEAD = /^<agent-message to="([^"]+)" name="([^"]*)">\n/
const CLOSE = "\n</agent-message>\n\n"

const oneLine = (name: string) => name.replace(/"/g, "").replace(/\s+/g, " ").trim()

export function agentMessage(id: string, name: string, text: string): string {
  const shown = oneLine(name)
  return [
    `<agent-message to="${id}" name="${shown}">`,
    text,
    "</agent-message>",
    "",
    `The user wrote this message to the background agent "${shown}". Pass it on with the SendMessage tool: to "${id}", message = the text between the tags, unchanged. Do not act on it yourself. After the call, reply with one short line.`,
  ].join("\n")
}

export function readAgentMessage(prompt: string): AgentMessage | null {
  const head = HEAD.exec(prompt)
  const end = prompt.lastIndexOf(CLOSE)
  if (!head || end < head[0].length) return null
  const [, id = "", name = ""] = head
  const text = prompt.slice(head[0].length, end)
  return agentMessage(id, name, text) === prompt ? { id, name, text } : null
}

export const shownText = (item: { text: string; to: { name: string } | null }) =>
  item.to ? `@${item.to.name} ${item.text}` : item.text

export function agentMessageLabel(prompt: string): string | null {
  const message = readAgentMessage(prompt)
  return message ? `@${message.name} ${message.text}` : null
}
