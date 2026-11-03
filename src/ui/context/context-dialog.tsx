import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import type { ContextReport } from "../../agent/agent.ts"
import { tildePath } from "../../rewind/common.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { PAD_X } from "../dialog/list-view.tsx"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { formatTokens, modelName } from "../format.ts"

const WIDTH = 72
const message = (text: string): DialogSection[] => [
  { title: "", rows: [{ id: "message", spans: [{ text, fg: theme.panelMuted }] }] },
]

const percent = (tokens: number, max: number) => `${max > 0 ? Math.round((tokens / max) * 100) : 0}%`

type Category = ContextReport["categories"][number]

// The files or tools a category holds; a category opens only when it has some.
const entriesOf = (usage: ContextReport, category: Category) =>
  category.holds === "files"
    ? usage.files.map((file) => [tildePath(file.path), file.tokens] as const)
    : category.holds === "tools"
      ? usage.tools.map((tool) => [`${tool.server} · ${tool.name}`, tool.tokens] as const)
      : []

function sectionsOf(usage: ContextReport, open: ReadonlySet<string>, barWidth: number): DialogSection[] {
  const used = usage.categories.filter((category) => category.kind === "used")
  const colorOf = new Map<string, RGBA>(
    used.map((category, index) => [category.name, theme.agents[index % theme.agents.length] ?? theme.accent]),
  )
  // Each used category takes a cell at least, and the bar stops at its width however small the rest is.
  let left = barWidth
  const bar = used.map((category) => {
    const share = usage.window > 0 ? Math.round((category.tokens / usage.window) * barWidth) : 0
    const cells = Math.min(left, Math.max(1, share))
    left -= cells
    return { text: "█".repeat(cells), fg: colorOf.get(category.name) ?? theme.accent }
  })
  const filled = barWidth - left
  const rows: DialogItem[] = [
    {
      id: "total",
      spans: [
        {
          text: `${modelName(usage.model)} · ${formatTokens(usage.used)} / ${formatTokens(usage.window)} (${percent(usage.used, usage.window)})`,
          fg: theme.text,
        },
      ],
    },
    { id: "bar", spans: [...bar, { text: "░".repeat(Math.max(0, barWidth - filled)), fg: theme.panelFaint }] },
    { id: "gap", spans: [] },
  ]
  for (const category of usage.categories) {
    const { id } = category
    const entries = entriesOf(usage, category)
    const opens = entries.length > 0
    const color = colorOf.get(category.name)
    rows.push({
      id,
      label: category.name,
      value: `${formatTokens(category.tokens).padStart(6)}  ${percent(category.tokens, usage.window).padStart(4)}${opens ? (open.has(id) ? "  ▾" : "  ›") : "   "}`,
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

// The bar and the total, for an agent that counts no categories.
function totalOf(usage: ContextReport, agent: string, barWidth: number): DialogSection[] {
  const bar = barWidth - 6
  const filled = usage.window > 0 ? Math.min(bar, Math.round((usage.used / usage.window) * bar)) : 0
  const used = formatTokens(usage.used)
  return [
    {
      title: "",
      rows: [
        {
          id: "bar",
          spans: [
            { text: "█".repeat(filled), fg: theme.accent },
            { text: "░".repeat(bar - filled), fg: theme.panelFaint },
            { text: `  ${percent(usage.used, usage.window)}`, fg: theme.text },
          ],
        },
        { id: "gap", spans: [] },
        {
          id: "total",
          spans: [
            {
              text: `${usage.window > 0 ? `${used} of ${formatTokens(usage.window)}` : used} tokens used`,
              fg: theme.text,
            },
          ],
        },
        { id: "note", spans: [{ text: `${agent} doesn't break this down further.`, fg: theme.panelMuted }] },
      ],
    },
  ]
}

// What fills the context window, from the agent's own count. `total` names the agent when it counts no categories.
export function ContextDialog(props: { load: () => Promise<ContextReport>; total?: string; onClose: () => void }) {
  const [usage, setUsage] = createSignal<ContextReport | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [open, setOpen] = createSignal(new Set<string>())
  // The bar fills the dialog, which narrows with a narrow terminal.
  const dimensions = useTerminalDimensions()
  const bar = () => Math.max(8, Math.min(WIDTH, dimensions().width) - 2 * PAD_X)
  onMount(() => {
    props.load().then(setUsage, (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  })
  return (
    <Dialog
      title={(() => {
        const shown = usage()
        return props.total !== undefined && shown ? `Context · ${shown.model}` : "Context"
      })()}
      width={WIDTH}
      sections={(() => {
        const shown = usage()
        if (shown && props.total !== undefined) return totalOf(shown, props.total, bar())
        if (shown) return sectionsOf(shown, open(), bar())
        const failed = problem()
        return message(failed ? `Could not read the context: ${failed}` : "Reading the context…")
      })()}
      footer={
        props.total === undefined
          ? [
              { key: "↑↓", action: "select" },
              { key: "enter", action: "open", needsRow: true },
              { key: "esc", action: "close" },
            ]
          : [{ key: "esc", action: "close" }]
      }
      footerStyle="keys"
      search={false}
      view="context"
      onEnter={(row) => {
        const shown = usage()
        const category = shown?.categories.find((entry) => entry.id === row.id)
        if (!shown || !category || entriesOf(shown, category).length === 0) return
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
