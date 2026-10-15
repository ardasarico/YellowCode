import { RGBA } from "@opentui/core"
import type { Tokens } from "marked"
import { diagramKind } from "grok-mermaid"
import { createContext, createMemo, createSignal, Index, Match, type JSX, Show, Switch, useContext } from "solid-js"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { DiffView, HEAD_LIMIT } from "../diff-view.tsx"
import { InlineImages } from "../inline-images.tsx"
import { is, splitBlocks, type Block } from "./blocks.ts"
import { type CalloutKind, calloutOf } from "./callout.ts"
import { isLineChart, parseChart } from "./chart.ts"
import { CodeBlock } from "./code-block.tsx"
import { drawDiagram } from "./diagram.ts"
import { ChartBars, DiagramArt, GanttView, LineChartImage, LineChartText, useKittyGraphics } from "./diagram-view.tsx"
import { type Details, type Entry, groupDetails, isDetails } from "./details.ts"
import { codeDiffRows, diffOf, drawsMermaid, FOLDED_CODE, foldId, foldNumbers, LONG_CODE, mermaidOf } from "./folds.ts"
import { parseGantt } from "./gantt.ts"
import { imageLines } from "./images.ts"
import { Inline, RefContext } from "./inline.tsx"
import { toUnicode } from "./math.ts"
import { refNumbers } from "./refs.ts"
import { Table } from "./table.tsx"

type BlockProps = { token: Entry; streaming: boolean; width: number; fg: RGBA; depth: number }

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

// Tip, Important, Warning and Caution take the terminal's ANSI green, magenta, yellow and red, or the painted theme's.
const CALLOUTS: Record<CalloutKind, { icon: string; label: string; color: () => RGBA }> = {
  note: { icon: "ℹ", label: "Note", color: () => theme.text },
  tip: { icon: "✦", label: "Tip", color: () => theme.success },
  important: { icon: "❖", label: "Important", color: () => theme.agents[1] ?? theme.accent },
  warning: { icon: "⚠", label: "Warning", color: () => theme.warning },
  caution: { icon: "✖", label: "Caution", color: () => theme.error },
}

export type MarkdownChat = {
  itemId: string
  selection: string | null
  expanded: Record<string, boolean>
  onOpenImage: (id: string) => void
  onOpenRef: (id: string) => void
  onToggle: (id: string) => void
}

const FoldContext = createContext<{ chat: () => MarkdownChat | undefined; numbers: () => Map<Entry, number> }>()

type Fold = { id: () => string | undefined; open: () => boolean; selected: () => boolean; toggle: () => void }

// Outside the chat a fold has no id and keeps its own open state.
function useFold(entry: () => Entry): Fold {
  const context = useContext(FoldContext)
  const [local, setLocal] = createSignal(false)
  const id = () => {
    const index = context?.numbers().get(entry())
    const itemId = context?.chat()?.itemId
    return index === undefined || itemId === undefined ? undefined : foldId(itemId, index)
  }
  const open = () => {
    const value = id()
    const chat = context?.chat()
    return value && chat ? chat.expanded[value] === true : local()
  }
  return {
    id,
    open,
    selected: () => id() !== undefined && context?.chat()?.selection === id(),
    toggle: () => {
      const value = id()
      const chat = context?.chat()
      if (value && chat) chat.onToggle(value)
      else setLocal(!local())
    },
  }
}

function FoldLine(props: { fold: Fold; hints?: [string, string]; children: JSX.Element }) {
  return (
    <box
      id={props.fold.id()}
      alignSelf="flex-start"
      backgroundColor={(props.fold.selected() ? theme.selection : null) ?? CLEAR}
      onMouseDown={(event) => {
        event.preventDefault()
        props.fold.toggle()
      }}
    >
      <text fg={theme.text} wrapMode="none">
        {props.children}
        <Show when={props.fold.selected()}>
          <span style={{ fg: theme.accent }}>
            {`   ↵ ${(props.hints ?? ["open", "close"])[props.fold.open() ? 1 : 0]}`}
          </span>
        </Show>
      </text>
    </box>
  )
}

// A paragraph that is only a `$$…$$` formula.
function blockMath(entry: Entry): string | undefined {
  const paragraph = is(entry, "paragraph")
  return paragraph ? /^\$\$([\s\S]+)\$\$$/.exec(paragraph.text.trim())?.[1] : undefined
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
      <Match when={isDetails(props.token) && props.token}>
        {(entry) => <DetailsView entry={entry()} width={props.width} fg={props.fg} depth={props.depth} />}
      </Match>
      <Match when={blockMath(props.token)}>
        {(tex) => (
          <box paddingLeft={4}>
            <text fg={theme.accent}>
              <span style={{ italic: true }}>{toUnicode(tex())}</span>
            </text>
          </box>
        )}
      </Match>
      <Match when={is(props.token, "paragraph") ?? is(props.token, "text")}>
        {(token) => <Inline tokens={token().tokens ?? [token()]} fg={props.fg} />}
      </Match>
      <Match when={is(props.token, "list")}>
        {(token) => <List token={token()} width={props.width} fg={props.fg} depth={props.depth} />}
      </Match>
      <Match when={calloutOf(props.token)}>
        {(callout) => {
          const look = () => CALLOUTS[callout().kind]
          return (
            <box border={["left"]} borderStyle="single" borderColor={look().color()} paddingLeft={1}>
              <text fg={look().color()}>
                <span style={{ bold: true }}>{`${look().icon} ${look().label}`}</span>
              </text>
              <Blocks tokens={callout().tokens} width={props.width - 2} fg={theme.text} depth={props.depth} gap={1} />
            </box>
          )
        }}
      </Match>
      <Match when={is(props.token, "blockquote")}>
        {(token) => (
          <box border={["left"]} borderStyle="single" borderColor={theme.frame} paddingLeft={1}>
            <Blocks tokens={token().tokens} width={props.width - 2} fg={theme.muted} depth={props.depth} gap={1} />
          </box>
        )}
      </Match>
      <Match when={mermaidOf(props.token)}>
        {(token) => <MermaidBlock token={token()} streaming={props.streaming} width={props.width} />}
      </Match>
      <Match when={diffOf(props.token)}>{(token) => <DiffBlock token={token()} />}</Match>
      <Match when={is(props.token, "code")}>{(token) => <Code token={token()} streaming={props.streaming} />}</Match>
      <Match when={is(props.token, "table")}>{(token) => <Table token={token()} width={props.width} />}</Match>
      <Match when={is(props.token, "hr")}>
        <text fg={theme.frame}>{"─".repeat(Math.max(1, props.width))}</text>
      </Match>
    </Switch>
  )
}

function Blocks(props: { tokens: readonly Entry[]; width: number; fg: RGBA; depth: number; gap: number }) {
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

function DetailsView(props: { entry: Details; width: number; fg: RGBA; depth: number }) {
  const fold = useFold(() => props.entry)
  return (
    <box flexDirection="column">
      <FoldLine fold={fold}>
        <span style={{ fg: theme.accent }}>{fold.open() ? "▾ " : "▸ "}</span>
        <span style={{ bold: true }}>{props.entry.summary}</span>
        <Show when={!fold.open()}>
          <span style={{ fg: theme.muted }}>{`  ${props.entry.lines} lines`}</span>
        </Show>
      </FoldLine>
      <Show when={fold.open()}>
        <box border={["left"]} borderStyle="single" borderColor={theme.frame} paddingLeft={1}>
          <Blocks tokens={props.entry.tokens} width={props.width - 2} fg={props.fg} depth={props.depth} gap={1} />
        </box>
      </Show>
    </box>
  )
}

function Code(props: { token: Tokens.Code; streaming: boolean }) {
  return (
    <Show
      when={props.token.text.split("\n").length > LONG_CODE}
      fallback={<CodeBlock lang={props.token.lang ?? ""} code={props.token.text} streaming={props.streaming} />}
    >
      <LongCode token={props.token} streaming={props.streaming} />
    </Show>
  )
}

function Note(props: { children: string }) {
  return (
    <box paddingLeft={2}>
      <text fg={theme.muted}>{props.children}</text>
    </box>
  )
}

// A mermaid block that draws shows a kind line, which toggles to its source. One that cannot draw stays code, with a
// note when its type is one we draw.
function MermaidBlock(props: { token: Tokens.Code; streaming: boolean; width: number }) {
  const fold = useFold(() => props.token)
  const kitty = useKittyGraphics()
  const text = () => props.token.text
  const chart = createMemo(() => parseChart(text()))
  const gantt = createMemo(() => (chart() ? null : parseGantt(text())))
  const drawing = createMemo(() => (chart() || gantt() ? null : drawDiagram(text(), props.width - 2, props.streaming)))
  const kind = () => {
    const value = chart()
    if (value) return value.type === "pie" ? "pie" : "chart"
    return gantt() ? "gantt" : (diagramKind(text()) ?? "mermaid")
  }
  const art = () => {
    const value = drawing()
    return value?.kind === "art" ? value.art : undefined
  }
  const wide = () => {
    const value = drawing()
    return value?.kind === "wide" ? value.columns : undefined
  }
  const lineChart = () => {
    const value = chart()
    return value?.type === "xy" && isLineChart(value) ? value : undefined
  }
  const known = () => chart() !== null || gantt() !== null || diagramKind(text()) !== null
  // While the first line is still coming the type is not known yet.
  const pending = () => props.streaming && (!text().includes("\n") || (known() && !drawsMermaid(text())))
  const source = () => <CodeBlock lang="" code={text()} streaming={props.streaming} />
  return (
    <Switch
      fallback={
        <box flexDirection="column">
          <Code token={props.token} streaming={props.streaming} />
          <Show when={known()}>
            <Note>diagram cannot be drawn</Note>
          </Show>
        </box>
      }
    >
      <Match when={pending()}>
        <box paddingLeft={2}>
          <text fg={theme.muted}>{kind()}</text>
        </box>
      </Match>
      <Match when={drawsMermaid(text())}>
        <box flexDirection="column">
          <box paddingLeft={2}>
            <FoldLine fold={fold} hints={wide() === undefined ? ["source", "diagram"] : undefined}>
              <span style={{ fg: theme.muted }}>{kind()}</span>
            </FoldLine>
          </box>
          <Switch>
            <Match when={fold.open()}>{source()}</Match>
            <Match when={wide()}>
              {(columns) => (
                <box flexDirection="column">
                  {source()}
                  <Note>{`diagram needs ${columns()} columns`}</Note>
                </box>
              )}
            </Match>
            <Match when={art()}>
              {(value) => (
                <box paddingLeft={2}>
                  <DiagramArt art={value()} />
                </box>
              )}
            </Match>
            <Match when={lineChart()}>
              {(value) => (
                <box paddingLeft={2}>
                  <Show
                    when={!props.streaming && kitty()}
                    fallback={<LineChartText chart={value()} width={props.width - 2} />}
                  >
                    <LineChartImage chart={value()} width={props.width - 2} />
                  </Show>
                </box>
              )}
            </Match>
            <Match when={chart()}>
              {(value) => (
                <box paddingLeft={2}>
                  <ChartBars chart={value()} width={props.width - 2} />
                </box>
              )}
            </Match>
            <Match when={gantt()}>
              {(value) => (
                <box paddingLeft={2}>
                  <GanttView gantt={value()} width={props.width - 2} />
                </box>
              )}
            </Match>
          </Switch>
        </box>
      </Match>
    </Switch>
  )
}

function LongCode(props: { token: Tokens.Code; streaming: boolean }) {
  const fold = useFold(() => props.token)
  const lines = () => props.token.text.split("\n")
  return (
    <box flexDirection="column" gap={1}>
      <CodeBlock
        lang={props.token.lang ?? ""}
        code={fold.open() ? props.token.text : lines().slice(0, FOLDED_CODE).join("\n")}
        streaming={props.streaming}
      />
      <box paddingLeft={2}>
        <FoldLine fold={fold}>
          <Show when={!fold.open()}>
            <span style={{ fg: theme.muted }}>{`+${lines().length - FOLDED_CODE} lines · `}</span>
          </Show>
          enter
          <span style={{ fg: theme.muted }}>{fold.open() ? " collapse" : " expand"}</span>
        </FoldLine>
      </box>
    </box>
  )
}

function DiffBlock(props: { token: Tokens.Code }) {
  const fold = useFold(() => props.token)
  const rows = () => codeDiffRows(props.token)
  const count = (kind: "add" | "del") => rows().filter((row) => row.kind === kind).length
  return (
    <box flexDirection="column" paddingLeft={2}>
      <FoldLine fold={fold}>
        <span style={{ fg: theme.muted }}>{`diff · +${count("add")} −${count("del")}`}</span>
      </FoldLine>
      <DiffView rows={rows()} tail={false} expanded={rows().length <= HEAD_LIMIT || fold.open()} />
    </box>
  )
}

function entryImages(entry: Entry, cwd: string): ChatImage[][] {
  return isDetails(entry) ? entry.tokens.flatMap((child) => entryImages(child, cwd)) : imageLines(entry, cwd)
}

// Local images leave their text and follow their block, numbered across the whole message.
export function Markdown(props: { markdown: string; streaming: boolean; width: number; chat?: MarkdownChat }) {
  let previous: Block[] = []
  const blocks = createMemo(() => {
    previous = splitBlocks(props.markdown, previous)
    return previous
  })
  const entries = createMemo(() => groupDetails(blocks().map((block) => block.token)))
  const numbers = createMemo(() => foldNumbers(entries()))
  const refs = createMemo(() => (props.chat ? refNumbers(entries(), process.cwd()) : new Map()))
  const refContext = () => {
    const chat = props.chat
    return (
      chat && {
        itemId: chat.itemId,
        selection: chat.selection,
        numbers: refs(),
        cwd: process.cwd(),
        onOpen: chat.onOpenRef,
      }
    )
  }
  const lines = createMemo(() => entries().map((entry) => entryImages(entry, process.cwd())))
  const offset = (index: number) =>
    lines()
      .slice(0, index)
      .reduce((sum, block) => sum + block.flat().length, 0)
  return (
    <FoldContext.Provider value={{ chat: () => props.chat, numbers }}>
      <RefContext.Provider value={refContext}>
        <box flexDirection="column" gap={1}>
          <Index each={entries()}>
            {(entry, index) => (
              <box flexDirection="column" gap={1}>
                <BlockView
                  token={entry()}
                  streaming={props.streaming && index === entries().length - 1}
                  width={props.width}
                  fg={theme.text}
                  depth={0}
                />
                <InlineImages
                  itemId={props.chat?.itemId}
                  lines={lines()[index] ?? []}
                  offset={offset(index)}
                  width={props.width}
                  selection={props.chat?.selection}
                  onOpen={props.chat?.onOpenImage}
                />
              </box>
            )}
          </Index>
        </box>
      </RefContext.Provider>
    </FoldContext.Provider>
  )
}
