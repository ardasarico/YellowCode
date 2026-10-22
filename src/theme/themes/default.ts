import type { ThemeColors, ThemeDefinition } from "../theme.ts"

const dark: ThemeColors = {
  background: "#121211",
  text: "#e6e6e5",
  muted: "#8f8f8e",
  frame: "#515151",
  accent: "#73bdf4",
  warning: "#ffd48c",
  error: "#ef8e88",
  band: "#1c1c1b",
  tile: "#222221",
  selection: "#222221",
  diffAdd: "#0d2713",
  diffDel: "#3b0f0f",
  diffAddText: "#6edd87",
  diffDelText: "#ef8e88",
  agents: ["#ef86ba", "#ad9eed", "#6edd87", "#ffd48c", "#73bdf4"],
  syntax: {
    keyword: "#ad9eed",
    string: "#6edd87",
    number: "#ef86ba",
    function: "#73bdf4",
    type: "#ffd48c",
    comment: "#8f8f8e",
  },
}

const light: ThemeColors = {
  background: "#fcfcfc",
  text: "#1a1a1a",
  muted: "#636362",
  frame: "#a8a8a6",
  accent: "#437ca4",
  warning: "#95712e",
  error: "#c64042",
  band: "#f3f3f3",
  tile: "#e9e9e8",
  selection: "#e9e9e8",
  diffAdd: "#dcf7e1",
  diffDel: "#f6dddb",
  diffAddText: "#2f8747",
  diffDelText: "#c64042",
  agents: ["#c3498b", "#7557c9", "#2f8747", "#95712e", "#437ca4"],
  syntax: {
    keyword: "#7557c9",
    string: "#2f8747",
    number: "#c3498b",
    function: "#437ca4",
    type: "#95712e",
    comment: "#636362",
  },
}

export const defaultDark: ThemeDefinition = { id: "default-dark", name: "Default Dark", dark, light: dark }
export const defaultLight: ThemeDefinition = { id: "default-light", name: "Default Light", dark: light, light }
