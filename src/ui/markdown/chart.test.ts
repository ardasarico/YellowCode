import { expect, test } from "bun:test"
import { parseChart } from "./chart.ts"

test("a pie chart reads its title and slices", () => {
  expect(parseChart('pie title Tokens\n  "cache read" : 70\n  "output" : 10')).toEqual({
    type: "pie",
    title: "Tokens",
    slices: [
      { label: "cache read", value: 70 },
      { label: "output", value: 10 },
    ],
  })
})

test("an xychart reads labels, the y range and every series", () => {
  const chart = parseChart(
    'xychart-beta horizontal\n  title "Cache"\n  x-axis [Jan, "Feb"]\n  y-axis "k" -20 --> 100\n  line [42, 48]\n  bar [38, 35]',
  )
  expect(chart).toEqual({
    type: "xy",
    title: "Cache",
    labels: ["Jan", "Feb"],
    range: [-20, 100],
    series: [
      { kind: "line", values: [42, 48] },
      { kind: "bar", values: [38, 35] },
    ],
    horizontal: true,
  })
})
