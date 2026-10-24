import { createSignal, onMount } from "solid-js"
import type { z } from "zod"
import type { usageReply } from "../../protocol/messages.ts"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { formatDuration, formatTokens, formatUntil, modelName } from "../format.ts"
import { levelColor } from "../meters.tsx"
import { resetTime } from "../sidebar.tsx"

export type Usage = z.infer<typeof usageReply>

const WIDTH = 72
const BAR = 20
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

function sectionsOf(usage: Usage, limits: Session["usage"]["limits"], now: number): DialogSection[] {
  const { session } = usage
  const models = Object.entries(session.model_usage).flatMap(([id, model]): DialogItem[] => [
    line(
      `model:${id}`,
      modelName(id),
      `in ${formatTokens(model.inputTokens)} · out ${formatTokens(model.outputTokens)}`,
    ),
    line(
      `cache:${id}`,
      "",
      `cache read ${formatTokens(model.cacheReadInputTokens)} · write ${formatTokens(model.cacheCreationInputTokens)}`,
    ),
  ])
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
    {
      title: "This session",
      rows: [
        line("cost", "Cost", `$${session.total_cost_usd.toFixed(2)}`),
        line(
          "time",
          "Time",
          `${formatDuration(session.total_duration_ms)} · API ${formatDuration(session.total_api_duration_ms)}`,
        ),
        line("lines", "Lines", `+${session.total_lines_added} −${session.total_lines_removed}`),
      ],
    },
    ...(models.length > 0 ? [{ title: "Models", rows: models }] : []),
    ...(plan.length > 0 || usage.subscription_type
      ? [{ title: usage.subscription_type ? `Plan · ${usage.subscription_type}` : "Plan", rows: plan }]
      : []),
  ]
}

// The session's cost and tokens from claude, and the plan limits the sidebar shows in short.
export function UsageDialog(props: {
  load: () => Promise<Usage>
  limits: Session["usage"]["limits"]
  onClose: () => void
}) {
  const [usage, setUsage] = createSignal<Usage | null>(null)
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
