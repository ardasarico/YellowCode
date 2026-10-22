import type { RGBA } from "@opentui/core"
import { Index } from "solid-js"
import { theme } from "../theme/theme.ts"

export type FoldState = { open: boolean; selected: boolean; hidden?: number; verbs?: [string, string]; gap?: string }

type Part = { text: string; fg: () => RGBA | undefined }

export function foldHintParts(state: FoldState): Part[] {
  const verb = (state.verbs ?? ["expand", "collapse"])[state.open ? 1 : 0]
  const count: Part[] = !state.open && state.hidden ? [{ text: `+${state.hidden} lines`, fg: () => theme.muted }] : []
  const key: Part[] = state.selected
    ? [
        { text: "enter", fg: () => theme.text },
        { text: ` ${verb}`, fg: () => theme.muted },
      ]
    : []
  const parts =
    count.length > 0 && key.length > 0 ? [...count, { text: " · ", fg: () => theme.muted }, ...key] : [...count, ...key]
  return parts.length > 0 && state.gap ? [{ text: state.gap, fg: () => theme.text }, ...parts] : parts
}

export const foldHintWidth = (state: FoldState) =>
  Bun.stringWidth(
    foldHintParts(state)
      .map((part) => part.text)
      .join(""),
  )

export function FoldHint(props: FoldState) {
  return <Index each={foldHintParts(props)}>{(part) => <span style={{ fg: part().fg() }}>{part().text}</span>}</Index>
}
