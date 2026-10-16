import { expect, test } from "bun:test"
import { chartImage, type XYChart } from "./chart-image.ts"

const size = { width: 400, height: 200, font: 12 }
const colors = { muted: "#888888", grid: "#444444", zero: "#888888", series: ["#ffcc00"] }
const line = (values: number[], range: [number, number] | null = null): XYChart => ({
  type: "xy",
  title: "",
  labels: [],
  range,
  series: [{ kind: "line", values }],
  horizontal: false,
})

test("a chart whose ticks cannot advance gives no image instead of hanging", () => {
  expect(chartImage(line([1, 2, 3], [10000000000000000, 10000000000000002]), size, colors)).toBeNull()
  expect(chartImage(line([-10000000000000002, -10000000000000000]), size, colors)).toBeNull()
})
