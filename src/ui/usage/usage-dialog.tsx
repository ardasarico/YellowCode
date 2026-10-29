import { createSignal, onMount } from "solid-js"
import type { UsageReport } from "../../agent/agent.ts"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { formatDuration, formatTokens, formatUntil, modelName } from "../format.ts"
import { levelColor } from "../meters.tsx"
import { resetTime } from "../sidebar.tsx"

const WIDTH = 72
const BAR = 12
const LABEL = 16

const line = (id: string, label: string, value: string): DialogItem => ({
  id,
  spans: [
    { text: label.padEnd(LABEL), fg: theme.panelMuted },
    { text: value, fg: theme.text },
  ],
})

const message = (text: string): DialogSection[] => [
  { title: "", rows: [{ id: "message", spans: [{ text, fg: theme.panelMuted }] }] },
]

function sectionsOf(usage: UsageReport, limits: Session["usage"]["limits"], now: number): DialogSection[] {
  const models = usage.models.flatMap((model): DialogItem[] => [
    line(
      `model:${model.model}`,
      modelName(model.model),
      `in ${formatTokens(model.input)} · out ${formatTokens(model.output)}`,
    ),
    line(
      `cache:${model.model}`,
      "",
      `cache read ${formatTokens(model.cacheRead)} · write ${formatTokens(model.cacheWrite)}`,
    ),
  ])
  const { costUsd, wallMs, apiMs, linesAdded, linesRemoved } = usage
  const session: DialogItem[] = [
    ...(costUsd === null ? [] : [line("cost", "Cost", `$${costUsd.toFixed(2)}`)]),
    ...(wallMs === null
      ? []
      : [line("time", "Time", `${formatDuration(wallMs)}${apiMs === null ? "" : ` · API ${formatDuration(apiMs)}`}`)]),
    ...(linesAdded === null || linesRemoved === null
      ? []
      : [line("lines", "Lines", `+${linesAdded} −${linesRemoved}`)]),
  ]
  const windows = [
    ["5 hours", limits.fiveHour],
    ["Week", limits.week],
    ...Object.entries(limits.models).map(([family, window]) => [`${family} week`, window] as const),
  ] as const
  const plan = windows.flatMap(([label, window]): DialogItem[] => {
    if (!window) return []
    const used = Math.min(1, Math.max(0, window.utilization))
    const filled = Math.round(used * BAR)
    return [
      {
        id: `limit:${label}`,
        spans: [
          { text: label.padEnd(LABEL), fg: theme.panelMuted },
          { text: "▇".repeat(filled), fg: levelColor(used) },
          { text: "▁".repeat(BAR - filled), fg: theme.panelFaint },
          { text: `  ${100 - Math.round(used * 100)}% left`, fg: levelColor(used) },
          {
            text: ` · ${formatUntil(window.resetsAt - now)} · ${resetTime(window.resetsAt, now)}`,
            fg: theme.panelMuted,
          },
        ],
      },
    ]
  })
  return [
    { title: "This session", rows: session },
    ...(models.length > 0 ? [{ title: "Models", rows: models }] : []),
    ...(plan.length > 0 || usage.plan ? [{ title: usage.plan ? `Plan · ${usage.plan}` : "Plan", rows: plan }] : []),
  ]
}

// The session's cost and tokens from the agent, and the plan limits the sidebar shows in short.
export function UsageDialog(props: {
  load: () => Promise<UsageReport>
  limits: Session["usage"]["limits"]
  onClose: () => void
}) {
  const [usage, setUsage] = createSignal<UsageReport | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  onMount(() => {
    props.load().then(setUsage, (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  })
  return (
    <Dialog
      title="Usage"
      width={WIDTH}
      sections={(() => {
        const shown = usage()
        if (shown) return sectionsOf(shown, props.limits, Date.now())
        const failed = problem()
        return message(failed ? `Could not read the usage: ${failed}` : "Reading the usage…")
      })()}
      footer={[{ key: "esc", action: "close" }]}
      footerStyle="keys"
      search={false}
      view="usage"
      onEnter={() => {}}
      onKey={() => false}
      onEscape={props.onClose}
    />
  )
}
