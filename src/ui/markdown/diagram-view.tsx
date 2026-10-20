import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { Cls, MermaidArt } from "grok-mermaid"
import { createMemo, createSignal, For, Index, type JSX, onCleanup, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { blank, type Cell, cellOf, sameCell, trackImage } from "../images.ts"
import { axisLabels, bar, type Chart, columnCell, columnTop, lineCells } from "./chart.ts"
import { chartImage, type XYChart } from "./chart-image.ts"
import { DAY, type Gantt, type GanttTask } from "./gantt.ts"

const LINE_ROWS = 10
const LINE_COLUMNS = 64
const IMAGE_ROWS = 12
const IMAGE_MIN_COLUMNS = 48
const IMAGE_POINT_COLUMNS = 6
const BAR_COLUMNS = 40
const COLUMN_ROWS = 8
const LABEL_COLUMNS = 24
const GANTT_COLUMNS = 56
const GUIDE_GAP = 6
const MONTH = 30.44 * DAY
const TONE = 0.18
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const artColor = (cls: Cls) => (cls === "text" || cls === "title" ? theme.text : theme.muted)
const seriesColor = (index: number) =>
  index === 0 ? theme.accent : (theme.agents[(index - 1) % theme.agents.length] ?? theme.accent)

const hex = (color: RGBA) =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`

const mix = (value: number, under: number) => Math.round(value * (1 - TONE) + under * TONE)

// Every second bar is a shade toward the background, so bars that touch still read as separate rows.
function toned(color: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [br, bg, bb] = theme.canvas.toInts()
  return RGBA.fromInts(mix(r, br), mix(g, bg), mix(b, bb))
}

const clip = (label: string, width: number) => (label.length > width ? `${label.slice(0, width - 1)}…` : label)

function Title(props: { children: string }) {
  return (
    <Show when={props.children}>
      <text fg={theme.text}>
        <span style={{ bold: true }}>{props.children}</span>
      </text>
    </Show>
  )
}

export function DiagramArt(props: { art: MermaidArt }) {
  return (
    <text wrapMode="none">
      <Index each={props.art.styled}>
        {(row, index) => (
          <>
            <Index each={row()}>{(span) => <span style={{ fg: artColor(span().cls) }}>{span().text}</span>}</Index>
            {index < props.art.styled.length - 1 ? "\n" : ""}
          </>
        )}
      </Index>
    </text>
  )
}

type BarRow = { label: string; value: number; shown: string; color: RGBA }

function HorizontalBars(props: { rows: BarRow[]; width: number }) {
  const labelWidth = () => Math.max(0, ...props.rows.map((row) => clip(row.label, LABEL_COLUMNS).length))
  const barWidth = () => Math.max(4, Math.min(BAR_COLUMNS, props.width - labelWidth() - 10))
  const max = () => Math.max(0, ...props.rows.map((row) => row.value))
  return (
    <For each={props.rows}>
      {(row) => (
        <text wrapMode="none">
          <span style={{ fg: theme.text }}>{clip(row.label, LABEL_COLUMNS).padEnd(labelWidth() + 2)}</span>
          <span style={{ fg: row.color }}>{bar(row.value, max(), barWidth()).padEnd(barWidth() + 2)}</span>
          <span style={{ fg: theme.muted }}>{row.shown}</span>
        </text>
      )}
    </For>
  )
}

const slotOf = (rows: BarRow[], width: number) => Math.max(3, Math.min(9, Math.floor(width / Math.max(1, rows.length))))

// Values sit above each bar and labels under it.
function VerticalBars(props: { rows: BarRow[]; width: number }) {
  const slot = () => slotOf(props.rows, props.width)
  const barWidth = () => Math.max(1, Math.min(5, slot() - 2))
  const max = () => Math.max(0, ...props.rows.map((row) => row.value))
  const center = (text: string) => {
    const room = slot() - text.length
    return " ".repeat(Math.floor(room / 2)) + text + " ".repeat(Math.ceil(room / 2))
  }
  const cell = (row: BarRow, line: number) =>
    line === columnTop(row.value, max(), COLUMN_ROWS)
      ? center(row.shown)
      : center(columnCell(row.value, max(), COLUMN_ROWS, line).repeat(barWidth()))
  return (
    <box flexDirection="column">
      <For each={Array.from({ length: COLUMN_ROWS + 1 }, (_, line) => line - 1)}>
        {(line) => (
          <text wrapMode="none">
            <For each={props.rows}>
              {(row) => (
                <span style={{ fg: line === columnTop(row.value, max(), COLUMN_ROWS) ? theme.muted : row.color }}>
                  {cell(row, line)}
                </span>
              )}
            </For>
          </text>
        )}
      </For>
      <text wrapMode="none" fg={theme.muted}>
        {props.rows.map((row) => center(row.label)).join("")}
      </text>
    </box>
  )
}

// Pie slices as horizontal bars in their own colours; xychart bars upright unless asked for `horizontal` or their
// labels do not fit under them.
export function ChartBars(props: { chart: Chart; width: number }) {
  const rows = createMemo((): BarRow[] => {
    const chart = props.chart
    if (chart.type === "pie") {
      const total = chart.slices.reduce((sum, slice) => sum + slice.value, 0) || 1
      return chart.slices.map((slice, index) => ({
        label: slice.label,
        value: slice.value,
        shown: `${Math.round((slice.value / total) * 100)}%`,
        color: theme.agents[index % theme.agents.length] ?? theme.accent,
      }))
    }
    const values = chart.series.find((one) => one.kind === "bar")?.values ?? []
    return values.map((value, index) => ({
      label: chart.labels[index] ?? String(index + 1),
      value,
      shown: String(value),
      color: index % 2 ? toned(theme.accent) : theme.accent,
    }))
  })
  const upright = () => {
    if (props.chart.type !== "xy" || props.chart.horizontal) return false
    const room = slotOf(rows(), props.width) - 1
    return rows().every((item) => item.label.length <= room && item.shown.length <= room)
  }
  return (
    <box flexDirection="column">
      <Title>{props.chart.title}</Title>
      <Show when={upright()} fallback={<HorizontalBars rows={rows()} width={props.width} />}>
        <VerticalBars rows={rows()} width={props.width} />
      </Show>
    </box>
  )
}

type LineSpan = { text: string; fg: RGBA }

export function LineChartText(props: { chart: XYChart; width: number }) {
  const values = () => props.chart.series.flatMap((one) => one.values)
  const high = () => props.chart.range?.[1] ?? Math.max(...values())
  const low = () => props.chart.range?.[0] ?? Math.min(0, ...values())
  const axis = () => Math.max(String(high()).length, String(low()).length)
  const columns = () => Math.max(8, Math.min(LINE_COLUMNS, props.width - axis() - 4))
  const rows = createMemo(() =>
    lineCells(
      props.chart.series.map((one) => one.values),
      columns(),
      LINE_ROWS,
      low(),
      high(),
    ).map((cells) => {
      const spans: LineSpan[] = []
      for (const cell of cells) {
        const fg = cell.series === -1 ? theme.frame : seriesColor(cell.series)
        const last = spans.at(-1)
        if (last && (last.fg === fg || cell.char === " ")) last.text += cell.char
        else spans.push({ text: cell.char, fg })
      }
      return spans
    }),
  )
  const tick = (index: number) => {
    if (index === 0) return String(high())
    return index === LINE_ROWS - 1 ? String(low()) : ""
  }
  return (
    <box flexDirection="column">
      <Title>{props.chart.title}</Title>
      <For each={rows()}>
        {(spans, index) => (
          <text wrapMode="none">
            <span style={{ fg: theme.muted }}>{`${tick(index()).padStart(axis())} ┤ `}</span>
            <For each={spans}>{(span) => <span style={{ fg: span.fg }}>{span.text}</span>}</For>
          </text>
        )}
      </For>
      <text wrapMode="none" fg={theme.muted}>
        {" ".repeat(axis() + 3) + axisLabels(props.chart.labels, columns())}
      </text>
    </box>
  )
}

// Until the terminal answers its capabilities, and without kitty graphics, charts stay text.
export function useKittyGraphics(): () => boolean {
  const renderer = useRenderer()
  return () => renderer.capabilities?.kitty_graphics === true
}

// Drawn at the pixel size of the cells it covers, so its labels come out at about the terminal's own text size.
export function LineChartImage(props: { chart: XYChart; width: number }) {
  const [cell, setCell] = createSignal<Cell | null>(null, { equals: sameCell })
  // As wide as its points need, so a chart with a handful of them does not stretch across the whole transcript.
  const columns = () => {
    const count = Math.max(...props.chart.series.map((one) => one.values.length))
    return Math.min(props.width, Math.max(IMAGE_MIN_COLUMNS, (count + 1) * IMAGE_POINT_COLUMNS))
  }
  const image = createMemo(() => {
    const size = cell()
    if (!size) return null
    const made = chartImage(
      props.chart,
      {
        width: Math.round(columns() * size.width),
        height: Math.round(IMAGE_ROWS * size.height),
        font: size.height * 0.65,
      },
      {
        muted: hex(theme.muted),
        grid: hex(theme.frame),
        zero: hex(theme.muted),
        series: [theme.accent, ...theme.agents].map(hex),
      },
      theme.background ? hex(theme.background) : null,
    )
    if (made) onCleanup(() => made.dispose())
    return made
  })
  // A chart whose axis cannot be drawn stays text.
  return (
    <box
      flexDirection="column"
      renderBefore={function () {
        setCell(cellOf(this))
      }}
    >
      <Show when={!cell() || image()} fallback={<LineChartText chart={props.chart} width={props.width} />}>
        <Title>{props.chart.title}</Title>
        <Show when={image()}>
          {(source) => (
            <Show when={!blank()} fallback={<box width={columns()} height={IMAGE_ROWS} />}>
              <image ref={trackImage} source={source()} fit="fit" width={columns()} height={IMAGE_ROWS} />
            </Show>
          )}
        </Show>
      </Show>
    </box>
  )
}

const dayName = (time: number) => {
  const day = new Date(time)
  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`
}

function taskColor(task: GanttTask): RGBA {
  if (task.tags.includes("crit")) return theme.error
  return task.tags.includes("done") ? theme.muted : theme.accent
}

function ganttRow(label: JSX.Element, body: JSX.Element) {
  return (
    <text wrapMode="none">
      {label}
      {body}
    </text>
  )
}

type Guide = { time: number; label: string }

const monthLabel = (time: number) => {
  const day = new Date(time)
  return `${MONTHS[day.getUTCMonth()]} '${String(day.getUTCFullYear()).slice(-2)}`
}

// The fewest months between guides that keeps them GUIDE_GAP columns apart: 1, 3 or 6 months, then 1, 2 or 5 years
// times a power of ten.
function monthStep(span: number, columns: number): number {
  const fits = (months: number) => (span / (months * MONTH)) * GUIDE_GAP <= columns
  for (const months of [1, 3, 6]) if (fits(months)) return months
  for (let years = 12; ; years *= 10) for (const factor of [1, 2, 5]) if (fits(factor * years)) return factor * years
}

// Weekly guides count from the first day; month and year guides sit on the calendar, so a 5-year step lands on 2005.
export function ganttGuides(first: number, last: number, columns: number): Guide[] {
  const span = last - first
  if (!Number.isFinite(span)) return []
  const guides: Guide[] = []
  const days = [7, 14].find((step) => (span / (step * DAY)) * GUIDE_GAP <= columns)
  if (days) {
    for (let time = first; time <= last; time += days * DAY) guides.push({ time, label: dayName(time) })
    return guides
  }
  const step = monthStep(span, columns)
  const start = new Date(first)
  let month = start.getUTCFullYear() * 12 + start.getUTCMonth()
  if (Date.UTC(start.getUTCFullYear(), start.getUTCMonth()) < first) month++
  month = Math.ceil(month / step) * step
  for (; ; month += step) {
    const time = Date.UTC(Math.floor(month / 12), month % 12)
    if (time > last) return guides
    guides.push({ time, label: step < 12 ? monthLabel(time) : String(Math.floor(month / 12)) })
  }
}

const lasting = (task: GanttTask) => {
  const days = Math.round((task.end - task.start) / DAY)
  return days > 0 && days % 7 === 0 ? `${days / 7}w` : `${days}d`
}

// Sections and their tasks against a dated axis, with dotted guides at weeks, months or years.
export function GanttView(props: { gantt: Gantt; width: number }) {
  const tasks = () => props.gantt.tasks
  const labelWidth = () => Math.min(LABEL_COLUMNS + 2, Math.max(...tasks().map((task) => task.name.length)) + 4)
  const first = () => Math.min(...tasks().map((task) => task.start))
  const last = () => Math.max(...tasks().map((task) => task.end))
  const columns = () => Math.max(10, Math.min(GANTT_COLUMNS, props.width - labelWidth() - 8))
  const at = (time: number) => Math.round(((time - first()) / (last() - first() || 1)) * columns())
  const steps = createMemo(() => ganttGuides(first(), last(), columns()))
  const guides = createMemo(() => new Set(steps().map((step) => at(step.time))))
  const axis = () => {
    const cells = Array.from({ length: columns() + 8 }, () => " ")
    let free = 0
    for (const step of steps()) {
      const column = at(step.time)
      const name = step.label
      if (column < free) continue
      for (let offset = 0; offset < name.length; offset++) cells[column + offset] = name[offset] ?? " "
      free = column + name.length + 2
    }
    return cells.join("").trimEnd()
  }
  const rule = () => {
    const marks = guides()
    return Array.from({ length: columns() }, (_, column) => (marks.has(column) ? "┬" : "─")).join("")
  }
  const blankRow = (from: number, to: number) => {
    const marks = guides()
    return Array.from({ length: Math.max(0, to - from) }, (_, offset) => (marks.has(from + offset) ? "┊" : " ")).join(
      "",
    )
  }
  const sections = () => [...new Set(tasks().map((task) => task.section))]
  return (
    <box flexDirection="column">
      <Title>{props.gantt.title}</Title>
      <text wrapMode="none" fg={theme.muted}>
        {" ".repeat(labelWidth()) + axis()}
      </text>
      <text wrapMode="none" fg={theme.frame}>
        {" ".repeat(labelWidth()) + rule()}
      </text>
      <For each={sections()}>
        {(section) => (
          <box flexDirection="column">
            <Show when={section}>
              {ganttRow(
                <span style={{ fg: theme.text, bold: true }}>
                  {clip(section, labelWidth() - 1).padEnd(labelWidth())}
                </span>,
                <span style={{ fg: theme.frame }}>{blankRow(0, columns())}</span>,
              )}
            </Show>
            <For each={tasks().filter((task) => task.section === section)}>
              {(task) => {
                const milestone = task.tags.includes("milestone")
                const note = milestone ? ` ${dayName(task.start)}` : ` ${lasting(task)}`
                const from = () => at(task.start)
                const to = () => Math.max(from() + 1, at(task.end))
                const end = () => (milestone ? from() + 1 : to()) + note.length
                return ganttRow(
                  <span style={{ fg: task.tags.includes("done") ? theme.muted : theme.text }}>
                    {`  ${clip(task.name, labelWidth() - 3)}`.padEnd(labelWidth())}
                  </span>,
                  <>
                    <span style={{ fg: theme.frame }}>{blankRow(0, from())}</span>
                    <span style={{ fg: taskColor(task) }}>{milestone ? "◆" : "█".repeat(to() - from())}</span>
                    <span style={{ fg: theme.muted }}>{note}</span>
                    <span style={{ fg: theme.frame }}>{blankRow(end(), columns())}</span>
                  </>,
                )
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
