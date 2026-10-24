import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, Match, onCleanup, Show, Switch } from "solid-js"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cut, REPLAY_NOTICE } from "../format.ts"
import { AgentPage, type PageProps } from "./agent-page.tsx"
import { ShellPage } from "./shell-page.tsx"
import { agentTree, messageable, shellNodes, taskIdOf, type TreeNode } from "./tree.ts"
import { TreeRows } from "./tree-rows.tsx"
import { WorkflowAgentPage, WorkflowPage } from "./workflow-page.tsx"

const NOTICE_MS = 4000
const FOOTER = [
  { key: "↑↓", word: "select" },
  { key: "pgup/pgdn", word: "scroll" },
  { key: "x", word: "stop" },
  { key: "esc", word: "chat" },
]
const MESSAGE_KEY = { key: "m", word: "message" }

const treeWidth = (width: number) => (width < 60 ? 0 : Math.max(30, Math.min(40, Math.floor(width * 0.26))))

const stoppable = (node: TreeNode) => node.state === "running" && node.kind !== "phase"

// The Shells section above its rows: a blank row, the title, the rule and another blank row.
const SHELLS_HEAD = 4

const runningCount = (nodes: TreeNode[]) => nodes.filter((node) => node.selectable && stoppable(node)).length

function SectionTitle(props: { title: string; running: number; width: number }) {
  return (
    <>
      <box flexDirection="row" justifyContent="space-between" paddingX={2} height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>{props.title}</span>
        </text>
        <text wrapMode="none" fg={theme.faint}>
          {props.running > 0 ? `${props.running} running` : ""}
        </text>
      </box>
      <box paddingX={2} height={1} flexShrink={0}>
        <text fg={theme.frame} wrapMode="none">
          {"─".repeat(Math.max(0, props.width - 4))}
        </text>
      </box>
    </>
  )
}

function Tree(props: {
  agents: TreeNode[]
  shells: TreeNode[]
  selected: string | null
  width: number
  onPick: (id: string) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  const withAgents = () => props.agents.length > 0 || props.shells.length === 0
  // The first run comes before any layout, when nothing can scroll yet, so a layout runs it again.
  const [layout, setLayout] = createSignal(0)
  createEffect(() => {
    layout()
    const agent = props.agents.findIndex((node) => node.id === props.selected)
    const shell = props.shells.findIndex((node) => node.id === props.selected)
    const index =
      agent !== -1 ? agent : shell === -1 ? -1 : shell + (withAgents() ? props.agents.length + SHELLS_HEAD : 0)
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
      <SectionTitle
        title={withAgents() ? "Agents" : "Shells"}
        running={runningCount(withAgents() ? props.agents : props.shells)}
        width={props.width}
      />
      <scrollbox
        ref={(element) => {
          scroll = element
          const resized = element.content.onSizeChange
          element.content.onSizeChange = () => {
            resized?.()
            setLayout((count) => count + 1)
          }
        }}
        flexGrow={1}
        marginTop={1}
        verticalScrollbarOptions={{ visible: false }}
      >
        <Show
          when={withAgents()}
          fallback={
            <TreeRows nodes={props.shells} selected={props.selected} width={props.width} onPick={props.onPick} />
          }
        >
          <TreeRows nodes={props.agents} selected={props.selected} width={props.width} onPick={props.onPick} />
          <Show when={props.shells.length > 0}>
            <box flexDirection="column" flexShrink={0} paddingY={1}>
              <SectionTitle title="Shells" running={runningCount(props.shells)} width={props.width} />
            </box>
            <TreeRows nodes={props.shells} selected={props.selected} width={props.width} onPick={props.onPick} />
          </Show>
        </Show>
      </scrollbox>
    </box>
  )
}

function Footer(props: { notice: string | null; width: number; message: boolean }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.frame} wrapMode="none">
        {"─".repeat(Math.max(0, props.width))}
      </text>
      <Show
        when={props.notice}
        fallback={
          <text wrapMode="none">
            <Index each={props.message ? [...FOOTER.slice(0, -1), MESSAGE_KEY, ...FOOTER.slice(-1)] : FOOTER}>
              {(entry, index) => (
                <>
                  <span style={{ fg: theme.faint }}>{index === 0 ? "" : " · "}</span>
                  <span style={{ fg: theme.text }}>{entry().key}</span>
                  <span style={{ fg: theme.muted }}>{` ${entry().word}`}</span>
                </>
              )}
            </Index>
          </text>
        }
      >
        {(text) => (
          <text wrapMode="none" fg={theme.warning}>
            {cut(text(), props.width)}
          </text>
        )}
      </Show>
    </box>
  )
}

function sameNode(a: TreeNode, b: TreeNode): boolean {
  const left: Record<string, unknown> = a
  const right: Record<string, unknown> = b
  return Object.keys(left).every((key) =>
    key === "progress"
      ? a.progress?.done === b.progress?.done &&
        a.progress?.failed === b.progress?.failed &&
        a.progress?.total === b.progress?.total &&
        a.progress?.tokens === b.progress?.tokens
      : left[key] === right[key],
  )
}

// A node keeps its object while nothing in it changed, so its row and page see no change.
function keepUnchanged(): (nodes: TreeNode[]) => TreeNode[] {
  let previous = new Map<string, TreeNode>()
  return (built) => {
    const nodes = built.map((node) => {
      const old = previous.get(node.id)
      return old && sameNode(old, node) ? old : node
    })
    previous = new Map(nodes.map((node) => [node.id, node]))
    return nodes
  }
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
      <Match when={props.node.kind === "shell"}>
        <ShellPage {...props} />
      </Match>
    </Switch>
  )
}

export function AgentView(props: {
  session: Session
  selected: string
  onSelect: (id: string) => void
  onClose: () => void
  onStop?: (taskId: string) => Promise<void>
  // Starts a message to the agent and closes the view; returns why it cannot, if so.
  onMessage?: (id: string) => string | null
  width: number
  height: number
}) {
  let scroll: ScrollBoxRenderable | undefined
  const keptAgents = keepUnchanged()
  const keptShells = keepUnchanged()
  const agents = createMemo(() => keptAgents(agentTree(props.session)))
  const shells = createMemo(() => keptShells(shellNodes(props.session)))
  const nodes = createMemo(() => [...agents(), ...shells()])
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

  const [notice, setNotice] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })
  const showNotice = (text: string) => {
    if (disposed) return
    clearTimeout(timer)
    setNotice(text)
    timer = setTimeout(() => setNotice(null), NOTICE_MS)
  }
  // The row changes when claude reports the task stopped, so only a failed request shows anything.
  const stop = (target: TreeNode, taskId: string) => {
    if (!props.onStop) return showNotice(REPLAY_NOTICE)
    props.onStop(taskId).catch((error: unknown) => {
      showNotice(`Cannot stop ${target.name}: ${error instanceof Error ? error.message : String(error)}`)
    })
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
    else if (key.name === "m") {
      const current = node()
      const why = current?.kind === "agent" ? props.onMessage?.(current.id) : null
      if (why) showNotice(why)
    } else if (key.name === "x") {
      const current = node()
      const taskId = current && stoppable(current) ? taskIdOf(props.session, current) : null
      if (current && taskId) stop(current, taskId)
    } else return
    key.preventDefault()
    key.stopPropagation()
  })

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Show when={tree() > 0}>
        <Tree agents={agents()} shells={shells()} selected={shownId()} width={tree()} onPick={props.onSelect} />
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
        <Footer
          notice={notice()}
          width={pageWidth()}
          message={(() => {
            const current = node()
            return current !== undefined && messageable(props.session, current)
          })()}
        />
      </box>
    </box>
  )
}
