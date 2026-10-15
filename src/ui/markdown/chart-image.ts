import { NativeImage } from "@opentui/core"
import { Resvg } from "@resvg/resvg-js"
import type { Chart } from "./chart.ts"

export type XYChart = Extract<Chart, { type: "xy" }>
export type ChartColors = { muted: string; grid: string; zero: string; series: string[] }
export type ChartSize = { width: number; height: number; font: number }

const FONT = "Menlo"

function niceStep(span: number, count: number): number {
  const raw = span / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")

// Catmull-Rom through the points, written as cubic Béziers.
function smooth(points: [number, number][]): string {
  const [start] = points
  if (!start) return ""
  let path = `M${start[0]},${start[1]}`
  for (let index = 0; index < points.length - 1; index++) {
    const p1 = points[index] ?? start
    const p0 = points[index - 1] ?? p1
    const p2 = points[index + 1] ?? p1
    const p3 = points[index + 2] ?? p2
    path += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6}`
    path += ` ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`
  }
  return path
}

// A line chart drawn to the pixel size it is shown at, so its text matches the terminal's. The title stays outside.
export function chartSvg(chart: XYChart, size: ChartSize, colors: ChartColors): string {
  const { width, height, font } = size
  const values = chart.series.flatMap((one) => one.values)
  let low = chart.range?.[0] ?? Math.min(0, ...values)
  let high = chart.range?.[1] ?? Math.max(...values)
  const step = niceStep(high - low || 1, 4)
  if (!chart.range) {
    low = Math.floor(low / step) * step
    high = Math.ceil(high / step) * step
  }
  const ticks: number[] = []
  for (let tick = Math.ceil(low / step) * step; tick <= high + step / 1000; tick += step)
    ticks.push(Math.round(tick * 1000) / 1000)
  const label = font * 0.85
  const glyph = label * 0.6
  const left = Math.max(...ticks.map((tick) => String(tick).length)) * glyph + font
  const top = font * 0.8
  const plotWidth = width - left - font
  const plotHeight = height - top - font * 2
  const count = Math.max(...chart.series.map((one) => one.values.length))
  const gap = plotWidth / Math.max(1, count - 1)
  const x = (index: number) => left + (count <= 1 ? plotWidth / 2 : index * gap)
  const y = (value: number) => top + (1 - (value - low) / (high - low || 1)) * plotHeight
  const text = (at: [number, number], anchor: string, content: string) =>
    `<text x="${at[0]}" y="${at[1]}" text-anchor="${anchor}" dominant-baseline="central" font-size="${label}" fill="${colors.muted}">${escape(content)}</text>`
  const parts: string[] = []
  for (const tick of ticks) {
    const zero = tick === 0 && low < 0
    const dash = zero ? "" : ` stroke-dasharray="${font / 7} ${font / 3}"`
    parts.push(
      `<line x1="${left}" x2="${left + plotWidth}" y1="${y(tick)}" y2="${y(tick)}" stroke="${zero ? colors.zero : colors.grid}" stroke-width="${font / 14}"${dash}/>`,
      text([left - font * 0.5, y(tick)], "end", String(tick)),
    )
  }
  const widest = Math.max(1, ...chart.labels.map((one) => one.length)) * glyph + font
  const every = Math.max(1, Math.ceil(widest / gap))
  chart.labels.forEach((one, index) => {
    const last = index === chart.labels.length - 1
    if (index % every !== 0 && !(last && (index % every) * gap >= widest)) return
    parts.push(text([x(index), top + plotHeight + font * 1.2], "middle", one))
  })
  chart.series.forEach((one, index) => {
    const color = colors.series[index % colors.series.length] ?? colors.muted
    const points = one.values.map((value, point): [number, number] => [x(point), y(value)])
    if (one.kind === "bar") {
      const barWidth = Math.min(font * 1.4, gap * 0.6)
      for (const [px, py] of points)
        parts.push(
          `<rect x="${px - barWidth / 2}" y="${Math.min(py, y(0))}" width="${barWidth}" height="${Math.abs(y(0) - py)}" rx="${font / 6}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="${font / 12}"/>`,
        )
      return
    }
    parts.push(
      `<path d="${smooth(points)}" fill="none" stroke="${color}" stroke-width="${font / 7}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    if (gap > font)
      for (const [px, py] of points) parts.push(`<circle cx="${px}" cy="${py}" r="${font / 5}" fill="${color}"/>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${FONT}, monospace">${parts.join("")}</svg>`
}

export function chartImage(chart: XYChart, size: ChartSize, colors: ChartColors): NativeImage | null {
  try {
    const svg = chartSvg(chart, size, colors)
    return NativeImage.decode(
      new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: FONT } }).render().asPng(),
    )
  } catch {
    return null
  }
}
