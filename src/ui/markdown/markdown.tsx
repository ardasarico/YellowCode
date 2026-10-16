import { RGBA } from "@opentui/core"
import type { Tokens } from "marked"
import { diagramKind } from "grok-mermaid"
import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  Index,
  Match,
  type JSX,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { DiffView, HEAD_LIMIT } from "../diff-view.tsx"
import { cut } from "../format.ts"
import { InlineImages } from "../inline-images.tsx"
import { finishedText, is, splitBlocks, type Block } from "./blocks.ts"
import { type CalloutKind, calloutOf } from "./callout.ts"
import { isLineChart, parseChart } from "./chart.ts"
import { CodeBlock } from "./code-block.tsx"
import { columnsCode, columnsOf, parseColumns } from "./columns.ts"
import { drawDiagram } from "./diagram.ts"
import { ChartBars, DiagramArt, GanttView, LineChartImage, LineChartText, useKittyGraphics } from "./diagram-view.tsx"
import { type Details, type Entry, groupDetails, isDetails, nestedEntries } from "./details.ts"
import { codeDiffRows, diffOf, drawsMermaid, FOLDED_CODE, foldId, foldNumbers, LONG_CODE, mermaidOf } from "./folds.ts"
import { parseGantt } from "./gantt.ts"
import { imageLines } from "./images.ts"
import { Inline, RefContext } from "./inline.tsx"
import { toUnicode } from "./math.ts"
import { refNumbers } from "./refs.ts"
import { parseStats, statsCode } from "./stats.ts"
import { StatsView } from "./stats-view.tsx"
import { Table } from "./table.tsx"
import { FOLDED_TREE, LONG_TREE, parseTree, treeCode } from "./tree.ts"
import { TreeView } from "./tree-view.tsx"

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

// A Match whose child can still read its value after the block changed kind, just before the Switch removes it. Solid
// throws "Stale read from <Match>" there, which happens while a reply streams; the child then sees its last value.
function Case<T>(props: {
  when: T | undefined | null | false
  children: (value: Accessor<NonNullable<T>>) => JSX.Element
}) {
  return (
    <Match when={props.when}>
      {(value) => {
        let last = untrack(value)
        return props.children(() => {
          try {
            last = value()
          } catch (error) {
            if (!String(error).includes("Stale read")) throw error
          }
          return last
        })
      }}
    </Match>
  )
}

// Headings inside a column are its title; columns inside a column stay code.
const InColumn = createContext(false)

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

const foldHint = (fold: Fold, hints: [string, string] = ["open", "close"]) => `   ↵ ${hints[fold.open() ? 1 : 0]}`

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
          <span style={{ fg: theme.accent }}>{foldHint(props.fold, props.hints)}</span>
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

function headingStyle(depth: number, inColumn: boolean): { fg: RGBA; bold: true } {
  if (inColumn) return { fg: theme.text, bold: true }
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
  const markerWidth = createMemo(() =>
    Math.max(...props.token.items.map((item, index) => marker(props.token, item, index).length)),
  )
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
                tokens={nestedEntries(item().tokens)}
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
  const inColumn = useContext(InColumn)
  return (
    <Switch fallback={<text fg={props.fg}>{props.token.raw.trimEnd()}</text>}>
      <Case when={is(props.token, "heading")}>
        {(token) => <Inline tokens={token().tokens} {...headingStyle(token().depth, inColumn)} />}
      </Case>
      <Case when={isDetails(props.token) && props.token}>
        {(entry) => <DetailsView entry={entry()} width={props.width} fg={props.fg} depth={props.depth} />}
      </Case>
      <Case when={blockMath(props.token)}>
        {(tex) => (
          <box paddingLeft={4}>
            <text fg={theme.accent}>
              <span style={{ italic: true }}>{toUnicode(tex())}</span>
            </text>
          </box>
        )}
      </Case>
      <Case when={is(props.token, "paragraph") ?? is(props.token, "text")}>
        {(token) => <Inline tokens={token().tokens ?? [token()]} fg={props.fg} />}
      </Case>
      <Case when={is(props.token, "list")}>
        {(token) => <List token={token()} width={props.width} fg={props.fg} depth={props.depth} />}
      </Case>
      <Case when={calloutOf(props.token)}>
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
      </Case>
      <Case when={is(props.token, "blockquote")}>
        {(token) => (
          <box border={["left"]} borderStyle="single" borderColor={theme.frame} paddingLeft={1}>
            <Blocks
              tokens={nestedEntries(token().tokens)}
              width={props.width - 2}
              fg={theme.muted}
              depth={props.depth}
              gap={1}
            />
          </box>
        )}
      </Case>
      <Case when={statsCode(props.token)}>
        {(token) => <StatsBlock token={token()} streaming={props.streaming} width={props.width} />}
      </Case>
      <Case when={!inColumn && columnsCode(props.token)}>
        {(token) => (
          <ColumnsBlock
            token={token()}
            streaming={props.streaming}
            width={props.width}
            fg={props.fg}
            depth={props.depth}
          />
        )}
      </Case>
      <Case when={treeCode(props.token)}>{(token) => <TreeBlock token={token()} streaming={props.streaming} />}</Case>
      <Case when={mermaidOf(props.token)}>
        {(token) => <MermaidBlock token={token()} streaming={props.streaming} width={props.width} />}
      </Case>
      <Case when={diffOf(props.token)}>{(token) => <DiffBlock token={token()} />}</Case>
      <Case when={is(props.token, "code")}>{(token) => <Code token={token()} streaming={props.streaming} />}</Case>
      <Case when={is(props.token, "table")}>{(token) => <Table token={token()} width={props.width} />}</Case>
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
  const count = () => `  ${props.entry.lines} ${props.entry.lines === 1 ? "line" : "lines"}`
  // A long summary is cut so the line count and the hint stay on the line.
  const summary = () => {
    const rest = (fold.open() ? "" : count()) + (fold.selected() ? foldHint(fold) : "")
    return cut(props.entry.summary, Math.max(1, props.width - 2 - Bun.stringWidth(rest)))
  }
  return (
    <box flexDirection="column">
      <FoldLine fold={fold}>
        <span style={{ fg: theme.accent }}>{fold.open() ? "▾ " : "▸ "}</span>
        <span style={{ bold: true }}>{summary()}</span>
        <Show when={!fold.open()}>
          <span style={{ fg: theme.muted }}>{count()}</span>
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
  // Inside a column the column rule is enough, so code drops its line numbers and label.
  const bare = useContext(InColumn)
  return (
    <Show
      when={props.token.text.split("\n").length > LONG_CODE}
      fallback={
        <CodeBlock lang={props.token.lang ?? ""} code={props.token.text} streaming={props.streaming} bare={bare} />
      }
    >
      <LongCode token={props.token} streaming={props.streaming} bare={bare} />
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
            <Case when={wide()}>
              {(columns) => (
                <box flexDirection="column">
                  {source()}
                  <Note>{`diagram needs ${columns()} columns`}</Note>
                </box>
              )}
            </Case>
            <Case when={art()}>
              {(value) => (
                <box paddingLeft={2}>
                  <DiagramArt art={value()} />
                </box>
              )}
            </Case>
            <Case when={lineChart()}>
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
            </Case>
            <Case when={chart()}>
              {(value) => (
                <box paddingLeft={2}>
                  <ChartBars chart={value()} width={props.width - 2} />
                </box>
              )}
            </Case>
            <Case when={gantt()}>
              {(value) => (
                <box paddingLeft={2}>
                  <GanttView gantt={value()} width={props.width - 2} />
                </box>
              )}
            </Case>
          </Switch>
        </box>
      </Match>
    </Switch>
  )
}

function MoreLine(props: { fold: Fold; hidden: number }) {
  return (
    <FoldLine fold={props.fold}>
      <Show when={!props.fold.open()}>
        <span style={{ fg: theme.muted }}>{`+${props.hidden} lines · `}</span>
      </Show>
      enter
      <span style={{ fg: theme.muted }}>{props.fold.open() ? " collapse" : " expand"}</span>
    </FoldLine>
  )
}

function LongCode(props: { token: Tokens.Code; streaming: boolean; bare: boolean }) {
  const fold = useFold(() => props.token)
  const lines = () => props.token.text.split("\n")
  return (
    <box flexDirection="column" gap={1}>
      <CodeBlock
        lang={props.token.lang ?? ""}
        code={fold.open() ? props.token.text : lines().slice(0, FOLDED_CODE).join("\n")}
        streaming={props.streaming}
        bare={props.bare}
      />
      <box paddingLeft={2}>
        <MoreLine fold={fold} hidden={lines().length - FOLDED_CODE} />
      </box>
    </box>
  )
}

// A block that is still streaming and has no finished line yet shows nothing rather than flashing as code.
function StatsBlock(props: { token: Tokens.Code; streaming: boolean; width: number }) {
  const text = () => finishedText(props.token.text, props.streaming)
  const stats = createMemo(() => parseStats(text()))
  return (
    <Switch fallback={<Code token={props.token} streaming={props.streaming} />}>
      <Case when={stats()}>{(value) => <StatsView stats={value()} width={props.width} />}</Case>
      <Match when={props.streaming && !text().trim()}>
        <box />
      </Match>
    </Switch>
  )
}

function TreeBlock(props: { token: Tokens.Code; streaming: boolean }) {
  const fold = useFold(() => props.token)
  const text = () => finishedText(props.token.text, props.streaming)
  const rows = createMemo(() => parseTree(text()))
  return (
    <Switch fallback={<Code token={props.token} streaming={props.streaming} />}>
      <Case when={rows()}>
        {(value) => (
          <Show when={value().length > LONG_TREE} fallback={<TreeView rows={value()} />}>
            <box flexDirection="column" gap={1}>
              <TreeView rows={fold.open() ? value() : value().slice(0, FOLDED_TREE)} />
              <MoreLine fold={fold} hidden={value().length - FOLDED_TREE} />
            </box>
          </Show>
        )}
      </Case>
      <Match when={props.streaming && !text().trim()}>
        <box />
      </Match>
    </Switch>
  )
}

const MIN_COLUMN = 24
const MIN_CODE_COLUMN = 40

// Ruled columns side by side; when one gets too narrow they stack with a rule between them.
function ColumnsBlock(props: { token: Tokens.Code; streaming: boolean; width: number; fg: RGBA; depth: number }) {
  const columns = createMemo(
    () => columnsOf(props.token) ?? (props.streaming ? parseColumns(props.token.text, true) : null),
  )
  const column = (tokens: Entry[], width: number) => (
    <InColumn.Provider value={true}>
      <Blocks tokens={tokens} width={width} fg={props.fg} depth={props.depth + 1} gap={1} />
    </InColumn.Provider>
  )
  return (
    <Show when={columns()} fallback={<Code token={props.token} streaming={props.streaming} />}>
      {(value) => {
        const count = () => value().length
        const widthOf = (index: number) => {
          const free = props.width - 3 * (count() - 1)
          return Math.floor(free / count()) + (index < free % count() ? 1 : 0)
        }
        const hasCode = () => value().some((tokens) => tokens.some((entry) => entry.type === "code"))
        const stacked = () => widthOf(count() - 1) < (hasCode() ? MIN_CODE_COLUMN : MIN_COLUMN)
        return (
          <Show
            when={!stacked()}
            fallback={
              <box flexDirection="column" gap={1}>
                <Index each={value()}>
                  {(tokens, index) => (
                    <>
                      <Show when={index > 0}>
                        <text fg={theme.frame} wrapMode="none">
                          {"─".repeat(Math.max(1, props.width))}
                        </text>
                      </Show>
                      {column(tokens(), props.width)}
                    </>
                  )}
                </Index>
              </box>
            }
          >
            <box flexDirection="row">
              <Index each={value()}>
                {(tokens, index) => (
                  <Show
                    when={index > 0}
                    fallback={
                      <box width={widthOf(index)} flexShrink={0}>
                        {column(tokens(), widthOf(index))}
                      </box>
                    }
                  >
                    <box
                      border={["left"]}
                      borderStyle="single"
                      borderColor={theme.frame}
                      marginLeft={1}
                      paddingLeft={1}
                      width={widthOf(index) + 2}
                      flexShrink={0}
                    >
                      {column(tokens(), widthOf(index))}
                    </box>
                  </Show>
                )}
              </Index>
            </box>
          </Show>
        )
      }}
    </Show>
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
  const starts = createMemo(() => {
    let sum = 0
    return lines().map((block) => {
      const start = sum
      sum += block.flat().length
      return start
    })
  })
  return (
    <FoldContext.Provider value={{ chat: () => props.chat, numbers }}>
      <RefContext.Provider value={refContext}>
        <box flexDirection="column" gap={1}>
          <Index each={entries()}>
            {(entry, index) => {
              // A memo, so finished blocks do not re-run their own memos on every delta.
              const streaming = createMemo(() => props.streaming && index === entries().length - 1)
              const block = () => (
                <BlockView token={entry()} streaming={streaming()} width={props.width} fg={theme.text} depth={0} />
              )
              // Only a block with images gets a box around it, which keeps the chat's node count down.
              return (
                <Show when={(lines()[index]?.length ?? 0) > 0} fallback={block()}>
                  <box flexDirection="column" gap={1}>
                    {block()}
                    <InlineImages
                      itemId={props.chat?.itemId}
                      lines={lines()[index] ?? []}
                      offset={starts()[index] ?? 0}
                      width={props.width}
                      selection={props.chat?.selection}
                      onOpen={props.chat?.onOpenImage}
                    />
                  </box>
                </Show>
              )
            }}
          </Index>
        </box>
      </RefContext.Provider>
    </FoldContext.Provider>
  )
}
