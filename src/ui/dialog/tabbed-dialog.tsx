import { type KeyEvent, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, type JSX, onCleanup, Show, untrack } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { Frame } from "./frame.tsx"
import { Footer, type FooterAction, onAccent, PAD_X } from "./list-view.tsx"
import { ConfirmPanel } from "./panel.tsx"

// What the open tab's body hands the dialog: it sees keys first while it has the focus.
type TabBody = {
  keys: (key: KeyEvent) => boolean
  footer: () => FooterAction[]
}

export type TabApi<Id extends string = string> = {
  focused: () => boolean
  // The panel's inner width and the rows between the tab strip and the footer.
  width: () => number
  rows: () => number
  bind: (body: TabBody) => void
  // False in a dialog of one tab, which has no strip to go up to.
  strip: () => boolean
  toStrip: () => void
  open(tab: Id): void
  notify: (text: string) => void
  // Asks over the dialog; true when the action was chosen.
  confirm: (question: Question) => Promise<boolean>
}

export type Question = { title: string; message: string; action: string }

export type Tab<Id extends string = string> = { id: Id; label: string; render: (api: TabApi<Id>) => JSX.Element }

const MAX_WIDTH = 120
const MAX_HEIGHT = 36
const FULL_SCREEN_BELOW = 80
const SHARE = 0.8
// The title and strip row, a rule and a blank; a blank, a rule and the footer; and the padding rows.
const FIXED_ROWS = 3 + 3 + 2
const NOTICE_MS = 4000

const STRIP_FOOTER: FooterAction[] = [
  { key: "←→", action: "switch tab" },
  { key: "↓", action: "back" },
  { key: "esc", action: "close" },
]

// A tab's search row has the focus until ↓ selects a row.
export const searchFooter = (esc: string, strip = true): FooterAction[] => [
  { key: "type", action: "to search" },
  { key: "↓", action: "list" },
  ...(strip ? [{ key: "↑", action: "tabs" }] : []),
  { key: "esc", action: esc },
]

function settingsSize(columns: number, rows: number) {
  if (columns < FULL_SCREEN_BELOW) return { width: columns, height: rows }
  return {
    width: Math.min(MAX_WIDTH, Math.floor(columns * SHARE)),
    height: Math.min(MAX_HEIGHT, Math.floor(rows * SHARE)),
  }
}

export function TabbedDialog<Id extends string>(props: {
  title: string
  tabs: Tab<Id>[]
  tab: Id
  onTab: (tab: Id) => void
  onClose: () => void
}) {
  const dimensions = useTerminalDimensions()
  const [focus, setFocus] = createSignal<"strip" | "body">("body")
  const [body, setBody] = createSignal<TabBody | null>(null)
  const [notice, setNotice] = createSignal<string>()
  const [asking, setAsking] = createSignal<{ question: Question; answer: (yes: boolean) => void } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  onCleanup(() => asking()?.answer(false))

  const size = () => settingsSize(dimensions().width, dimensions().height)
  const inner = () => Math.max(0, size().width - PAD_X * 2)
  const left = () => Math.floor((dimensions().width - size().width) / 2)
  const top = () => Math.floor((dimensions().height - size().height) / 2)
  const rows = () => Math.max(0, size().height - FIXED_ROWS)

  const index = () =>
    Math.max(
      0,
      props.tabs.findIndex((tab) => tab.id === props.tab),
    )
  const step = (by: 1 | -1) => {
    const next = props.tabs[Math.max(0, Math.min(props.tabs.length - 1, index() + by))]
    if (next) props.onTab(next.id)
  }

  const api: TabApi<Id> = {
    focused: () => focus() === "body",
    width: inner,
    rows,
    bind: (next) => {
      setBody(() => next)
      onCleanup(() => setBody((current) => (current === next ? null : current)))
    },
    strip: () => props.tabs.length > 1,
    toStrip: () => {
      if (props.tabs.length > 1) setFocus("strip")
    },
    open: (tab) => {
      setFocus("body")
      props.onTab(tab)
    },
    notify: (text) => {
      clearTimeout(timer)
      setNotice(text)
      timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    },
    confirm: (question) =>
      new Promise((resolve) => {
        untrack(asking)?.answer(false)
        setAsking({
          question,
          answer: (yes) => {
            setAsking(null)
            resolve(yes)
          },
        })
      }),
  }

  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    const open = asking()
    if (open) {
      if (key.name === "return" || key.name === "escape") open.answer(key.name === "return")
      return
    }
    if (focus() === "body") {
      if (body()?.keys(key)) return
      if (key.name === "escape") props.onClose()
      return
    }
    if (key.name === "left" || key.name === "right") step(key.name === "left" ? -1 : 1)
    else if (key.name === "down" || key.name === "return") setFocus("body")
    else if (key.name === "escape") props.onClose()
  })

  // The tabs that fit beside the title and "esc", a run that holds the active one; "‹" and "›" mark the rest.
  const shownTabs = () => {
    const room = inner() - Bun.stringWidth(props.title) - 2 - 4
    const widths = props.tabs.map((tab) => Bun.stringWidth(tab.label) + 2)
    if (widths.reduce((sum, one) => sum + one, 0) <= room) return { tabs: props.tabs, before: false, after: false }
    const active = Math.max(
      0,
      props.tabs.findIndex((tab) => tab.id === props.tab),
    )
    let first = active
    let last = active
    let used = (widths[active] ?? 0) + 2
    while (last + 1 < widths.length && used + (widths[last + 1] ?? 0) <= room) used += widths[++last] ?? 0
    while (first > 0 && used + (widths[first - 1] ?? 0) <= room) used += widths[--first] ?? 0
    return { tabs: props.tabs.slice(first, last + 1), before: first > 0, after: last < props.tabs.length - 1 }
  }

  // A span's style only ever adds: an unset bg or bold keeps the old one, so each change draws a new span.
  const Strip = () => (
    <box height={1} paddingLeft={PAD_X} paddingRight={PAD_X} flexDirection="row">
      <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
        {props.title}
      </text>
      <text marginLeft={2} wrapMode="none" flexShrink={1} visible={props.tabs.length > 1}>
        <span style={{ fg: theme.panelMuted }}>{shownTabs().before ? "‹" : ""}</span>
        <For each={shownTabs().tabs}>
          {(tab) => () => {
            const active = tab.id === props.tab
            const filled = active && focus() === "strip"
            return (
              <span
                style={{
                  fg: filled ? onAccent() : active ? theme.accent : theme.panelMuted,
                  bg: filled ? theme.accent : undefined,
                  bold: active,
                }}
              >
                {` ${tab.label} `}
              </span>
            )
          }}
        </For>
        <span style={{ fg: theme.panelMuted }}>{shownTabs().after ? "›" : ""}</span>
      </text>
      <box flexGrow={1} />
      <text fg={theme.panelMuted} wrapMode="none" flexShrink={0} marginLeft={1}>
        esc
      </text>
    </box>
  )

  const Rule = () => (
    <box height={1} paddingLeft={PAD_X}>
      <text fg={theme.frame} wrapMode="none">
        {"─".repeat(inner())}
      </text>
    </box>
  )

  return (
    <>
      <Frame panel={{ x: left(), y: top(), width: size().width, height: size().height }}>
        <Strip />
        <Rule />
        <box height={1} />
        <box height={rows()} flexDirection="column" overflow="hidden">
          <For each={props.tabs}>{(tab) => <Show when={tab.id === props.tab}>{tab.render(api)}</Show>}</For>
        </box>
        <box height={1} />
        <Rule />
        <Footer
          items={focus() === "strip" ? STRIP_FOOTER : (body()?.footer() ?? [])}
          keys
          notice={notice()}
          width={inner()}
          fit
        />
      </Frame>
      <Show when={asking()}>{(open) => <ConfirmPanel {...open().question} />}</Show>
    </>
  )
}
