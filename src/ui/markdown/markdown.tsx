import type { RGBA } from "@opentui/core"
import type { Token, Tokens } from "marked"
import { createMemo, Index, Match, Switch } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { splitBlocks, type Block } from "./blocks.ts"
import { CodeBlock } from "./code-block.tsx"
import { Inline } from "./inline.tsx"
import { Table } from "./table.tsx"

type BlockProps = { token: Token; streaming: boolean; width: number; fg: RGBA; depth: number }

function isType<T extends Token["type"]>(token: Token, type: T): token is Extract<Token, { type: T }> {
  return token.type === type
}

function is<T extends Token["type"]>(token: Token, type: T): Extract<Token, { type: T }> | undefined {
  return isType(token, type) ? token : undefined
}

function headingStyle(depth: number): { fg: RGBA; bold: true } {
  if (depth === 1) return { fg: theme.accent, bold: true }
  if (depth === 2) return { fg: theme.text, bold: true }
  return { fg: theme.muted, bold: true }
}

function marker(list: Tokens.List, item: Tokens.ListItem, index: number): string {
  if (item.task) return item.checked ? "[x] " : "[ ] "
  if (!list.ordered) return "· "
  const start = typeof list.start === "number" ? list.start : 1
  return `${start + index}. `
}

function List(props: { token: Tokens.List; width: number; fg: RGBA; depth: number }) {
  const indent = () => (props.depth === 0 ? 2 : 0)
  const markerWidth = () => Math.max(...props.token.items.map((item, index) => marker(props.token, item, index).length))
  return (
    <box flexDirection="column" paddingLeft={indent()}>
      <Index each={props.token.items}>
        {(item, index) => (
          <box flexDirection="row">
            <text fg={theme.muted} width={markerWidth()} flexShrink={0}>
              {marker(props.token, item(), index)}
            </text>
            <box flexDirection="column" flexGrow={1}>
              <Blocks
                tokens={item().tokens}
                width={props.width - indent() - markerWidth()}
                fg={props.fg}
                depth={props.depth + 1}
                gap={0}
              />
            </box>
          </box>
        )}
      </Index>
    </box>
  )
}

function BlockView(props: BlockProps) {
  return (
    <Switch fallback={<text fg={props.fg}>{props.token.raw.trimEnd()}</text>}>
      <Match when={is(props.token, "heading")}>
        {(token) => <Inline tokens={token().tokens} {...headingStyle(token().depth)} />}
      </Match>
      <Match when={is(props.token, "paragraph") ?? is(props.token, "text")}>
        {(token) => <Inline tokens={token().tokens ?? [token()]} fg={props.fg} />}
      </Match>
      <Match when={is(props.token, "list")}>
        {(token) => <List token={token()} width={props.width} fg={props.fg} depth={props.depth} />}
      </Match>
      <Match when={is(props.token, "blockquote")}>
        {(token) => (
          <box border={["left"]} borderStyle="single" borderColor={theme.frame} paddingLeft={1}>
            <Blocks tokens={token().tokens} width={props.width - 2} fg={theme.muted} depth={props.depth} gap={1} />
          </box>
        )}
      </Match>
      <Match when={is(props.token, "code")}>
        {(token) => <CodeBlock lang={token().lang ?? ""} code={token().text} streaming={props.streaming} />}
      </Match>
      <Match when={is(props.token, "table")}>{(token) => <Table token={token()} width={props.width} />}</Match>
      <Match when={is(props.token, "hr")}>
        <text fg={theme.frame}>{"─".repeat(Math.max(1, props.width))}</text>
      </Match>
    </Switch>
  )
}

function Blocks(props: { tokens: readonly Token[]; width: number; fg: RGBA; depth: number; gap: number }) {
  const visible = () => props.tokens.filter((token) => token.type !== "space" && token.type !== "checkbox")
  return (
    <box flexDirection="column" gap={props.gap}>
      <Index each={visible()}>
        {(token) => (
          <BlockView token={token()} streaming={false} width={props.width} fg={props.fg} depth={props.depth} />
        )}
      </Index>
    </box>
  )
}

export function Markdown(props: { markdown: string; streaming: boolean; width: number }) {
  let previous: Block[] = []
  const blocks = createMemo(() => {
    previous = splitBlocks(props.markdown, previous)
    return previous
  })
  return (
    <box flexDirection="column" gap={1}>
      <Index each={blocks()}>
        {(block, index) => (
          <BlockView
            token={block().token}
            streaming={props.streaming && index === blocks().length - 1}
            width={props.width}
            fg={theme.text}
            depth={0}
          />
        )}
      </Index>
    </box>
  )
}
