export type Slice = { label: string; value: number }
export type Series = { kind: "bar" | "line"; values: number[] }
export type Chart =
  | { type: "pie"; title: string; slices: Slice[] }
  | {
      type: "xy"
      title: string
      labels: string[]
      range: [number, number] | null
      series: Series[]
      horizontal: boolean
    }

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, "$1")

function list(text: string): string[] {
  return text.split(",").map(unquote)
}

// Mermaid's `pie` and `xychart-beta`. A chart whose header is known but whose data has not arrived yet comes back empty.
export function parseChart(code: string): Chart | null {
  const lines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"))
  const head = lines[0] ?? ""
  if (/^pie\b/.test(head)) {
    const title = /\btitle\s+(.+)$/.exec(head)?.[1] ?? lines.find((line) => line.startsWith("title "))?.slice(6) ?? ""
    const slices = lines.flatMap((line) => {
      const match = /^"(.+)"\s*:\s*(-?[\d.]+)$/.exec(line)
      return match ? [{ label: match[1] ?? "", value: Number(match[2]) }] : []
    })
    return { type: "pie", title: unquote(title), slices: slices.filter((slice) => slice.value > 0) }
  }
  if (/^xychart(-beta)?\b/.test(head)) {
    let title = ""
    let labels: string[] = []
    let range: [number, number] | null = null
    const series: Series[] = []
    for (const line of lines.slice(1)) {
      const titled = /^title\s+(.+)$/.exec(line)
      const xAxis = /^x-axis\b.*\[(.*)\]$/.exec(line)
      const yAxis = /^y-axis\b.*?(-?[\d.]+)\s*-->\s*(-?[\d.]+)$/.exec(line)
      const data = /^(bar|line)\b.*\[(.*)\]$/.exec(line)
      if (titled) title = unquote(titled[1] ?? "")
      else if (xAxis) labels = list(xAxis[1] ?? "")
      else if (yAxis) range = [Number(yAxis[1]), Number(yAxis[2])]
      else if (data) {
        const values = list(data[2] ?? "").map(Number)
        if (values.length > 0 && values.every(Number.isFinite))
          series.push({ kind: data[1] === "line" ? "line" : "bar", values })
      }
    }
    return { type: "xy", title, labels, range, series, horizontal: /\bhorizontal\b/.test(head) }
  }
  return null
}

export function hasData(chart: Chart): boolean {
  return chart.type === "pie" ? chart.slices.length > 0 : chart.series.length > 0
}

export const isLineChart = (chart: Chart) => chart.type === "xy" && chart.series.some((one) => one.kind === "line")

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const LOWER = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"]

export function bar(value: number, max: number, width: number): string {
  const units = Math.max(0, Math.round((value / (max || 1)) * width * 8))
  return "█".repeat(Math.floor(units / 8)) + (EIGHTHS[units % 8] ?? "")
}

// One row of a vertical bar, counted from the top of a chart `height` rows tall.
export function columnCell(value: number, max: number, height: number, row: number): string {
  const units = Math.max(0, Math.round((value / (max || 1)) * height * 8)) - (height - 1 - row) * 8
  if (units >= 8) return "█"
  return units > 0 ? (LOWER[units] ?? "") : " "
}

// The row just above a vertical bar, where its value goes.
export function columnTop(value: number, max: number, height: number): number {
  return height - 1 - Math.ceil(Math.max(0, Math.round((value / (max || 1)) * height * 8)) / 8)
}

// One cell of a text line chart: which series drew it, or -1 for the zero rule.
export type LineCell = { char: string; series: number }

// Rises and falls are drawn with box corners joined by │, flat runs with ─, data points with ●. Later series draw over
// earlier ones.
export function lineCells(series: number[][], width: number, height: number, low: number, high: number): LineCell[][] {
  const grid: LineCell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", series: -2 })),
  )
  const rowOf = (value: number) =>
    Math.max(0, Math.min(height - 1, Math.round((1 - (value - low) / (high - low || 1)) * (height - 1))))
  const set = (row: number, column: number, char: string, index: number) => {
    const cell = grid[row]?.[column]
    if (cell) Object.assign(cell, { char, series: index })
  }
  if (low < 0 && high > 0) for (let column = 0; column < width; column++) set(rowOf(0), column, "┈", -1)
  series.forEach((values, index) => {
    const at = (column: number) => {
      const position = (column / Math.max(1, width - 1)) * (values.length - 1)
      const left = Math.min(Math.max(0, values.length - 2), Math.floor(position))
      const a = values[left] ?? 0
      const b = values[left + 1] ?? a
      return rowOf(a + (b - a) * (position - left))
    }
    let previous = at(0)
    for (let column = 0; column < width; column++) {
      const row = at(column)
      if (column === 0 || row === previous) set(row, column, "─", index)
      else {
        const rising = row < previous
        set(previous, column, rising ? "╯" : "╮", index)
        for (let between = Math.min(row, previous) + 1; between < Math.max(row, previous); between++)
          set(between, column, "│", index)
        set(row, column, rising ? "╭" : "╰", index)
      }
      previous = row
    }
    values.forEach((value, point) => {
      set(rowOf(value), Math.round((point / Math.max(1, values.length - 1)) * (width - 1)), "●", index)
    })
  })
  return grid
}

// Labels spread under the chart; when they would crowd, only every n-th one and the last are shown.
export function axisLabels(labels: string[], width: number): string {
  const cells = Array.from({ length: width }, () => " ")
  const every = Math.max(1, Math.ceil((labels.length * 6) / width))
  labels.forEach((label, index) => {
    if (index % every !== 0 && index !== labels.length - 1) return
    const at = Math.round((index / Math.max(1, labels.length - 1)) * (width - 1))
    const start = Math.max(0, Math.min(width - label.length, at - Math.floor(label.length / 2)))
    for (let offset = 0; offset < label.length; offset++) cells[start + offset] = label[offset] ?? " "
  })
  return cells.join("").trimEnd()
}
