import type { RGBA } from "@opentui/core"
import { createSignal, onMount } from "solid-js"
import type { z } from "zod"
import type { contextUsage } from "../../protocol/messages.ts"
import { tildePath } from "../../rewind/common.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { formatTokens, modelName } from "../format.ts"

export type ContextUsage = z.infer<typeof contextUsage>

const WIDTH = 72
const BAR = WIDTH - 8
// Categories that open to their entries.
const OPENS = new Set(["memory_files", "mcp_tools"])

const message = (text: string): DialogSection[] => [
  { title: "", rows: [{ id: "message", spans: [{ text, fg: theme.panelMuted }] }] },
]

const percent = (tokens: number, max: number) => `${max > 0 ? Math.round((tokens / max) * 100) : 0}%`

function sectionsOf(usage: ContextUsage, open: ReadonlySet<string>): DialogSection[] {
  const used = usage.categories.filter((category) => category.kind === "used")
  const colorOf = new Map<string, RGBA>(
    used.map((category, index) => [category.name, theme.agents[index % theme.agents.length] ?? theme.accent]),
  )
  // Each used category takes a cell at least, and the bar stops at its width however small the rest is.
  let left = BAR
  const bar = used.map((category) => {
    const share = usage.maxTokens > 0 ? Math.round((category.tokens / usage.maxTokens) * BAR) : 0
    const cells = Math.min(left, Math.max(1, share))
    left -= cells
    return { text: "█".repeat(cells), fg: colorOf.get(category.name) ?? theme.accent }
  })
  const filled = BAR - left
  const rows: DialogItem[] = [
    {
      id: "total",
      spans: [
        {
          text: `${modelName(usage.model)} · ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)} (${Math.round(usage.percentage)}%)`,
          fg: theme.text,
        },
      ],
    },
    { id: "bar", spans: [...bar, { text: "░".repeat(Math.max(0, BAR - filled)), fg: theme.panelFaint }] },
    { id: "gap", spans: [] },
  ]
  for (const category of usage.categories) {
    const id = category.id ?? category.name
    const entries =
      id === "memory_files"
        ? usage.memoryFiles.map((file) => [tildePath(file.path), file.tokens] as const)
        : id === "mcp_tools"
          ? usage.mcpTools.map((tool) => [`${tool.serverName} · ${tool.name}`, tool.tokens] as const)
          : []
    const opens = OPENS.has(id) && entries.length > 0
    const color = colorOf.get(category.name)
    rows.push({
      id,
      label: category.name,
      value: `${formatTokens(category.tokens).padStart(6)}  ${percent(category.tokens, usage.maxTokens).padStart(4)}${opens ? (open.has(id) ? "  ▾" : "  ›") : "   "}`,
      marker: { text: color ? "■" : "□", fg: color ?? theme.panelFaint },
      labelColor: color ? undefined : theme.panelMuted,
    })
    if (opens && open.has(id))
      for (const [name, tokens] of entries)
        rows.push({
          id: `${id}:${name}`,
          indent: 4,
          spans: [{ text: `${name}  ${formatTokens(tokens)}`, fg: theme.panelMuted }],
        })
  }
  return [{ title: "", rows }]
}

// What fills the context window, from claude's own count.
export function ContextDialog(props: { load: () => Promise<ContextUsage>; onClose: () => void }) {
  const [usage, setUsage] = createSignal<ContextUsage | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [open, setOpen] = createSignal(new Set<string>())
  onMount(() => {
    props.load().then(setUsage, (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  })
  return (
    <Dialog
      title="Context"
      width={WIDTH}
      sections={(() => {
        const shown = usage()
        if (shown) return sectionsOf(shown, open())
        const failed = problem()
        return message(failed ? `Could not read the context: ${failed}` : "Reading the context…")
      })()}
      footer={[
        { key: "↑↓", action: "select" },
        { key: "enter", action: "open", needsRow: true },
        { key: "esc", action: "close" },
      ]}
      footerStyle="keys"
      search={false}
      view="context"
      onEnter={(row) => {
        if (!OPENS.has(row.id)) return
        setOpen((previous) => {
          const next = new Set(previous)
          if (!next.delete(row.id)) next.add(row.id)
          return next
        })
      }}
      onKey={() => false}
      onEscape={props.onClose}
    />
  )
}
