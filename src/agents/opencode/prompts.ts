// Prompts and opencode's user messages. opencode keeps a session's messages in the order they were made, not by id,
// and takes the id a client gives, so a PromptId is the message id without its `msg_` prefix and history gives the
// same id back. A fork's copies get new ids.
import type { z } from "zod"
import type { Prompt } from "../../agent/agent.ts"
import type { PromptId } from "../../agent/ids.ts"
import type { Image } from "../../agent/tools.ts"
import type { userFiles } from "./wire/messages.ts"

const PREFIX = "msg_"

export const messageOf = (prompt: PromptId): string => `${PREFIX}${prompt}`

export const promptOf = (message: string): PromptId =>
  message.startsWith(PREFIX) ? message.slice(PREFIX.length) : message

const nameOf = (index: number) => `Image ${index + 1}`

// Images go as `data:` uris, which opencode stores inline and hands the model as image blocks.
const filesOf = (prompt: Prompt) =>
  prompt.images.length > 0
    ? {
        files: prompt.images.map((image, index) => ({
          uri: `data:${image.mediaType};base64,${image.base64}`,
          name: nameOf(index),
        })),
      }
    : {}

export function promptBody(prompt: Prompt) {
  return { id: messageOf(prompt.id), text: prompt.text, delivery: prompt.delivery, ...filesOf(prompt) }
}

// A command takes no id: opencode makes the message from the command's template.
export function commandBody(prompt: Prompt, command: { name: string; args: string }) {
  return { name: command.name, text: command.args, delivery: prompt.delivery, ...filesOf(prompt) }
}

// A prompt's images as they show, named as `promptBody` sends them.
export const promptImages = (prompt: Prompt): Image[] =>
  prompt.images.map((image, index) => ({
    name: nameOf(index),
    mediaType: image.mediaType,
    data: image.base64,
    path: null,
  }))

// The images of a stored or enqueued user message; other files are not shown.
export function imagesOf(files: z.infer<typeof userFiles> = []): Image[] {
  return files
    .filter((file) => file.mime.startsWith("image/"))
    .map((file, index) => ({
      name: file.name ?? nameOf(index),
      mediaType: file.mime,
      data: file.data ?? null,
      path: null,
    }))
}
