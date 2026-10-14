import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, Match, onCleanup, Show, Switch } from "solid-js"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"
import { AgentPage, type PageProps } from "./agent-page.tsx"
import { agentTree, type TreeNode } from "./tree.ts"
import { TreeRows } from "./tree-rows.tsx"
import { WorkflowAgentPage, WorkflowPage } from "./workflow-page.tsx"

const NOTICE_MS = 4000
const STOP_NOTICE = "Stopping comes with the live connection"
const FOOTER = [
  { key: "↑↓", word: "agent" },
  { key: "pgup/pgdn", word: "scroll" },
  { key: "x", word: "stop" },
  { key: "esc", word: "chat" },
]
const FOOTER_WIDTH = Bun.stringWidth(FOOTER.map((entry) => `${entry.key} ${entry.word}`).join(" · "))

const treeWidth = (width: number) => (width < 60 ? 0 : Math.max(30, Math.min(40, Math.floor(width * 0.26))))

const stoppable = (node: TreeNode) => node.state === "running" && node.kind !== "phase"

function Tree(props: { nodes: TreeNode[]; selected: string | null; width: number; onPick: (id: string) => void }) {
  let scroll: ScrollBoxRenderable | undefined
  const running = () => props.nodes.filter((node) => node.selectable && stoppable(node)).length
  createEffect(() => {
    const index = props.nodes.findIndex((node) => node.id === props.selected)
    if (!scroll || index === -1) return
    if (index < scroll.scrollTop) scroll.scrollTo(index)
    else if (index >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(index - scroll.viewport.height + 1)
  })
  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      paddingY={1}
      backgroundColor={theme.band ?? theme.canvas}
    >
      <box flexDirection="row" justifyContent="space-between" paddingX={2} height={1}>
        <text wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>Agents</span>
        </text>
        <text wrapMode="none" fg={theme.faint}>
          {running() > 0 ? `${running()} running` : ""}
        </text>
      </box>
      <box paddingX={2} height={1}>
        <text fg={theme.frame} wrapMode="none">
          {"─".repeat(Math.max(0, props.width - 4))}
        </text>
      </box>
      <scrollbox
        ref={(element) => (scroll = element)}
        flexGrow={1}
        marginTop={1}
        verticalScrollbarOptions={{ visible: false }}
      >
        <TreeRows nodes={props.nodes} selected={props.selected} width={props.width} onPick={props.onPick} />
      </scrollbox>
    </box>
  )
}

function Footer(props: { notice: boolean; width: number }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.frame} wrapMode="none">
        {"─".repeat(Math.max(0, props.width))}
      </text>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text wrapMode="none" flexShrink={0}>
          <Index each={FOOTER}>
            {(entry, index) => (
              <>
                <span style={{ fg: theme.faint }}>{index === 0 ? "" : " · "}</span>
                <span style={{ fg: theme.text }}>{entry().key}</span>
                <span style={{ fg: theme.muted }}>{` ${entry().word}`}</span>
              </>
            )}
          </Index>
        </text>
        <Show when={props.notice}>
          <text wrapMode="none" fg={theme.warning} flexShrink={1}>
            {cut(STOP_NOTICE, Math.max(0, props.width - FOOTER_WIDTH - 2))}
          </text>
        </Show>
      </box>
    </box>
  )
}

function Page(props: PageProps & { rows: TreeNode[] }) {
  return (
    <Switch>
      <Match when={props.node.kind === "agent"}>
        <AgentPage {...props} />
      </Match>
      <Match when={props.node.kind === "workflow"}>
        <WorkflowPage {...props} />
      </Match>
      <Match when={props.node.kind === "workflow-agent"}>
        <WorkflowAgentPage {...props} />
      </Match>
    </Switch>
  )
}

export function AgentView(props: {
  session: Session
  selected: string
  onSelect: (id: string) => void
  onClose: () => void
  width: number
  height: number
}) {
  let scroll: ScrollBoxRenderable | undefined
  const nodes = createMemo(() => agentTree(props.session))
  const byId = createMemo(() => new Map(nodes().map((node) => [node.id, node])))
  const node = () => byId().get(props.selected) ?? nodes().find((entry) => entry.selectable)
  const shownId = createMemo(() => node()?.id ?? null)
  const tree = () => treeWidth(props.width)
  const pageWidth = () => props.width - tree() - 4

  const startedBy = (target: TreeNode) => {
    let parent = target.parentId ? byId().get(target.parentId) : undefined
    while (parent?.kind === "phase") parent = parent.parentId ? byId().get(parent.parentId) : undefined
    return parent?.name ?? "main"
  }
  const descendants = (target: TreeNode) => {
    const list = nodes()
    const start = list.indexOf(target) + 1
    const end = list.findIndex((entry, index) => index >= start && entry.depth <= target.depth)
    return list.slice(start, end === -1 ? undefined : end)
  }

  const [notice, setNotice] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const showNotice = () => {
    clearTimeout(timer)
    setNotice(true)
    timer = setTimeout(() => setNotice(false), NOTICE_MS)
  }

  const move = (step: 1 | -1) => {
    const selectable = nodes().filter((entry) => entry.selectable)
    const current = selectable.findIndex((entry) => entry.id === shownId())
    const next = selectable[Math.min(selectable.length - 1, Math.max(0, current + step))]
    if (next && next.id !== shownId()) props.onSelect(next.id)
  }

  useKeyboard((key) => {
    if (key.ctrl || key.meta) return
    const page = () => Math.max(1, (scroll?.viewport.height ?? 0) - 2)
    if (key.name === "up") move(-1)
    else if (key.name === "down") move(1)
    else if (key.name === "pageup") scroll?.scrollBy({ x: 0, y: -page() })
    else if (key.name === "pagedown") scroll?.scrollBy({ x: 0, y: page() })
    else if (key.name === "escape") props.onClose()
    else if (key.name === "x") {
      const current = node()
      if (current && stoppable(current)) showNotice()
    } else return
    key.preventDefault()
    key.stopPropagation()
  })

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Show when={tree() > 0}>
        <Tree nodes={nodes()} selected={shownId()} width={tree()} onPick={props.onSelect} />
      </Show>
      <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Show when={shownId()} keyed>
          {(id) => {
            // Each node gets a fresh page that opens at the top; the old page's scrollbox goes with it.
            scroll = undefined
            return (
              <Show when={byId().get(id)}>
                {(shown) => (
                  <Page
                    session={props.session}
                    node={shown()}
                    startedBy={startedBy(shown())}
                    rows={shown().kind === "workflow" ? descendants(shown()) : []}
                    width={pageWidth()}
                    scrollRef={(element) => (scroll = element)}
                  />
                )}
              </Show>
            )
          }}
        </Show>
        <Footer notice={notice()} width={pageWidth()} />
      </box>
    </box>
  )
}
