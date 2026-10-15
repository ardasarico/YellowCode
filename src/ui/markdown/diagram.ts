import { diagramKind, type MermaidArt, render } from "grok-mermaid"

export type Drawing =
  | { kind: "art"; art: MermaidArt }
  | { kind: "wide"; columns: number }
  | { kind: "broken" }
  | { kind: "pending" }

const SIDEWAYS = /^(\s*(?:graph|flowchart)\s+)(LR|RL)\b/

// Null when grok-mermaid does not draw this type, so the block stays a plain code block. A sideways flowchart that
// does not fit is drawn top-down instead.
export function drawDiagram(code: string, width: number, streaming: boolean): Drawing | null {
  if (!diagramKind(code)) return null
  const art = render(code)
  if (!art) return streaming ? { kind: "pending" } : { kind: "broken" }
  if (art.width <= width) return { kind: "art", art }
  const upright = SIDEWAYS.test(code) ? render(code.replace(SIDEWAYS, "$1TD")) : null
  if (upright && upright.width <= width) return { kind: "art", art: upright }
  return { kind: "wide", columns: Math.min(art.width, upright?.width ?? Infinity) }
}
