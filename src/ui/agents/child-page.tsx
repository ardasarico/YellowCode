import { createStore } from "solid-js/store"
import { ChatView, createRows } from "../chat-view.tsx"
import { formatDuration } from "../format.ts"
import { AgentOfChat } from "../turn-end.tsx"
import { useDuration } from "./agent-line.tsx"
import { MetaLine, PageHeader, type PageProps } from "./agent-page.tsx"
import type { ChildView } from "./tree.ts"

const none = () => {}

// A subagent YellowCode runs, shown whole as its own chat. Its asks are answered in the session's chat, so none is
// answered here.
export function ChildPage(props: PageProps & { child: ChildView }) {
  const duration = useDuration(() => props.node)
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const rows = createRows(() => props.child.store.state, expanded)
  const providerId = () => props.child.providerId
  const meta = () => [
    "subagent",
    props.child.name === props.child.model ? "" : props.child.model,
    `started by ${props.startedBy}`,
  ]
  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        node={props.node}
        stats={props.node.startedAt === null ? "" : formatDuration(duration())}
        right={props.child.provider}
        width={props.width}
      />
      <MetaLine parts={meta()} width={props.width} />
      <box flexDirection="column" flexGrow={1} marginTop={1}>
        <AgentOfChat.Provider value={providerId}>
          <ChatView
            rows={rows}
            session={props.child.store.state}
            workspace={{ cwd: props.child.store.state.info?.cwd ?? "", branch: null, version: "" }}
            model={props.child.model}
            commands={[]}
            width={props.width}
            selected={null}
            expanded={expanded}
            onOverflow={none}
            onToggle={(id) => setExpanded(id, (open) => !open)}
            onOpenAgent={none}
            onOpenImage={none}
            onOpenRef={none}
            docked={() => false}
            imagesBefore={() => 0}
            earlier={false}
            onReachTop={none}
            onScrollState={none}
            scrollRef={props.scrollRef}
            onRedo={none}
          />
        </AgentOfChat.Provider>
      </box>
    </box>
  )
}
