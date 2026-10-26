import { useTerminalDimensions } from "@opentui/solid"
import { Index, type JSX, untrack } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { wrapLines } from "../format.ts"
import { Frame } from "./frame.tsx"
import { Footer, Line, PAD_X } from "./list-view.tsx"

export const WIDTH = 64
// The padding rows, the title, the blank under it, the blank over the footer and the footer.
export const CHROME_ROWS = 6

// A panel of the given size, centered, with the title, a blank row, the body and the footer.
export function Panel(props: {
  width: number
  height: number
  title: string
  footer: { key: string; action: string }[]
  // Called once; the sizes are accessors, so a resize does not rebuild the body.
  children: (inner: () => number, rows: () => number) => JSX.Element
}) {
  const dimensions = useTerminalDimensions()
  const width = () => Math.min(props.width, dimensions().width)
  const height = () => Math.min(props.height, dimensions().height - 2)
  const inner = () => Math.max(0, width() - PAD_X * 2)
  const rows = () => Math.max(0, height() - CHROME_ROWS)
  return (
    <Frame
      panel={{
        x: Math.floor((dimensions().width - width()) / 2),
        y: Math.max(0, Math.floor((dimensions().height - height()) / 2)),
        width: width(),
        height: height(),
      }}
    >
      <Line
        left={{ text: props.title, fg: theme.text }}
        right={{ text: "esc", fg: theme.panelMuted }}
        bold
        width={inner()}
      />
      <box height={1} />
      <box height={rows()} paddingLeft={PAD_X} flexDirection="column" overflow="hidden">
        {untrack(() => props.children(inner, rows))}
      </box>
      <box height={1} />
      <Footer items={props.footer} width={inner()} />
    </Frame>
  )
}

// A question with one action and Cancel; whoever shows it handles enter and esc.
export function ConfirmPanel(props: { title: string; message: string; action: string }) {
  const lines = () => wrapLines(props.message, WIDTH - PAD_X * 2, 20)
  return (
    <Panel
      width={WIDTH}
      height={CHROME_ROWS + lines().length}
      title={props.title}
      footer={[
        { action: props.action, key: "enter" },
        { action: "Cancel", key: "esc" },
      ]}
    >
      {() => <Index each={lines()}>{(line) => <text fg={theme.text}>{line()}</text>}</Index>}
    </Panel>
  )
}
