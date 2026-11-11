import { z } from "zod"
import type { ClientTool } from "../agent/agent.ts"
import { OWN_MEMORY_SERVER } from "../protocol/messages.ts"
import { memoryList } from "./prompt.ts"
import { forgetMemory, listMemories, MEMORY_TYPES, readMemory, saveMemory } from "./store.ts"

// The tools reach an agent as client tools of this server, beside the mods' servers.
export const MEMORY_SERVER = OWN_MEMORY_SERVER

const NAME = { type: "string", description: "The memory's name: short kebab-case, as in the list." }

export const MEMORY_TOOLS = [
  {
    name: "remember",
    description:
      "Save one fact to this project's memory, which every later session reads, with any provider. A name already " +
      "in the list replaces that memory, which is how you update one. YellowCode shows the user each memory you save.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "type", "body"],
      properties: {
        name: NAME,
        description: { type: "string", description: "One line that tells a later session when this memory matters." },
        type: { type: "string", enum: MEMORY_TYPES },
        body: {
          type: "string",
          description: "The fact. For feedback and project memories, add why it holds and how to apply it.",
        },
      },
    },
  },
  {
    name: "forget",
    description: "Delete a memory that is wrong, out of date, or that the user asked you to forget.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: NAME } },
  },
  {
    name: "recall",
    description:
      "Read one memory in full. The list in your instructions holds only each memory's name and one line, as they " +
      "were when the session started; leave the name out to get the list as it is now.",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: NAME } },
  },
]

const REMEMBER = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(MEMORY_TYPES),
  body: z.string(),
})
const NAMED = z.object({ name: z.string() })

export type MemoryToolResult = { text: string; error: boolean }

// A line for the chat about a memory that was saved or forgotten.
export type Tell = (text: string) => void

export const savedLine = (name: string, replaced: boolean) => `Memory ${replaced ? "updated" : "saved"}: ${name}`
export const forgotLine = (name: string) => `Memory forgotten: ${name}`

const failed = (text: string): MemoryToolResult => ({ text, error: true })

const invalid = (error: z.ZodError) =>
  `Invalid input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}. remember takes name, description, type and body; forget and recall take name.`

function remember(folder: string, input: unknown, tell?: Tell): MemoryToolResult {
  const parsed = REMEMBER.safeParse(input)
  if (!parsed.success) return failed(invalid(parsed.error))
  const saved = saveMemory(folder, parsed.data)
  if (!saved.ok) return failed(saved.problem)
  tell?.(savedLine(parsed.data.name, saved.replaced))
  return { text: `${saved.replaced ? "Updated" : "Saved"} ${parsed.data.name}.`, error: false }
}

export function callMemoryTool(name: string, input: unknown, folder: string, tell?: Tell): MemoryToolResult {
  if (name === "remember") return remember(folder, input, tell)
  if (name === "recall" && !NAMED.safeParse(input).success)
    return { text: memoryList(listMemories(folder)), error: false }
  const parsed = NAMED.safeParse(input)
  if (!parsed.success) return failed(invalid(parsed.error))
  const missing = failed(`There is no memory named ${parsed.data.name}.`)
  if (name === "forget") {
    if (!forgetMemory(folder, parsed.data.name)) return missing
    tell?.(forgotLine(parsed.data.name))
    return { text: `Forgot ${parsed.data.name}.`, error: false }
  }
  if (name === "recall") {
    const memory = readMemory(folder, parsed.data.name)
    if (!memory) return missing
    return { text: `${memory.name} (${memory.type}): ${memory.description}\n\n${memory.body}`, error: false }
  }
  return failed(`Unknown tool ${name}.`)
}

export const memoryClientTools = (folder: string, tell?: Tell): ClientTool[] =>
  MEMORY_TOOLS.map((tool) => ({
    server: MEMORY_SERVER,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnly: tool.name === "recall", destructive: false },
    run: (input) => Promise.resolve(callMemoryTool(tool.name, input, folder, tell)),
  }))
