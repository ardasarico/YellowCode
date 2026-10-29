import type { AgentEvent } from "../../agent/events.ts"
import type { Image } from "../../agent/tools.ts"
import type { ContentBlock, UserBlock } from "../../protocol/messages.ts"

type Untimed<E> = E extends unknown ? Omit<E, "at"> : never

// An event before it gets its line's time.
export type Draft = Untimed<AgentEvent>

export const textOf = (content: readonly (ContentBlock | UserBlock)[]): string =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")

export function imagesOf(
  blocks: { type: string; source?: { media_type?: string; data?: string } }[],
  name: (index: number) => string,
  path: string | null = null,
): Image[] {
  const sources = blocks.flatMap((block) => (block.type === "image" && block.source?.data ? [block.source] : []))
  return sources.map((source, index) => ({
    name: name(index),
    mediaType: source.media_type ?? "image/png",
    data: source.data ?? null,
    path,
  }))
}
