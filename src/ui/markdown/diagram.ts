import { diagramKind, type MermaidArt, render } from "grok-mermaid"

export type Drawing =
  | { kind: "art"; art: MermaidArt }
  | { kind: "wide"; columns: number }
  | { kind: "broken" }
  | { kind: "pending" }

const SIDEWAYS = /^(\s*(?:graph|flowchart)\s+)(LR|RL)\b/
const STATE_EDGE = /^(?<head>\s*(?<from>\S+)\s*-->\s*(?<to>[^\s:]+)\s*:\s*)(?<label>.*?)(?<tail>\s*)$/
const FLOW_EDGE = /^(?<head>\s*(?<from>\w+)\s*(?<arrow>[-=.ox<>]+)\|)(?<label>[^|]*)(?<tail>\|\s*(?<to>\w+)\s*;?\s*)$/

// grok-mermaid draws parallel edges on one route, which hides every label but the first, so the labels are joined
// onto the first edge.
function joinParallelLabels(code: string): string {
  const lines = code.split("\n")
  const edges = new Map<string, { index: number; head: string; tail: string; labels: string[] }>()
  const dropped = new Set<number>()
  lines.forEach((line, index) => {
    const edge = (STATE_EDGE.exec(line) ?? FLOW_EDGE.exec(line))?.groups
    if (!edge?.label) return
    const key = `${edge.from} ${edge.arrow ?? ""} ${edge.to}`
    const seen = edges.get(key)
    if (!seen) {
      edges.set(key, { index, head: edge.head ?? "", tail: edge.tail ?? "", labels: [edge.label] })
      return
    }
    if (!seen.labels.includes(edge.label)) seen.labels.push(edge.label)
    dropped.add(index)
  })
  if (dropped.size === 0) return code
  for (const edge of edges.values()) lines[edge.index] = edge.head + edge.labels.join(" / ") + edge.tail
  return lines.filter((_, index) => !dropped.has(index)).join("\n")
}

// Null when grok-mermaid does not draw this type, so the block stays a plain code block. A sideways flowchart that
// does not fit is drawn top-down instead.
export function drawDiagram(code: string, width: number, streaming: boolean): Drawing | null {
  if (!diagramKind(code)) return null
  code = joinParallelLabels(code)
  const art = render(code)
  if (!art) return streaming ? { kind: "pending" } : { kind: "broken" }
  if (art.width <= width) return { kind: "art", art }
  const upright = SIDEWAYS.test(code) ? render(code.replace(SIDEWAYS, "$1TD")) : null
  if (upright && upright.width <= width) return { kind: "art", art: upright }
  return { kind: "wide", columns: Math.min(art.width, upright?.width ?? Infinity) }
}
