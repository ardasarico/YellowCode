import { type OptimizedBuffer, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, type JSX, onCleanup, onMount, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { cover, SCRIM } from "../images.ts"
import { DimmedImages } from "./dimmed-images.tsx"
import { fill } from "./list-view.tsx"

type Rect = { x: number; y: number; width: number; height: number }

const MARGIN = 0.03

// The rectangle a full-screen viewer takes, a small margin in from the terminal edge.
export function useViewPanel(): () => Rect {
  const dimensions = useTerminalDimensions()
  return () => {
    const { width, height } = dimensions()
    const gapX = Math.max(1, Math.round(width * MARGIN))
    const gapY = Math.max(1, Math.round(height * MARGIN))
    return { x: gapX, y: gapY, width: width - 2 * gapX, height: height - 2 * gapY }
  }
}

// A panel over the dimmed app.
export function Frame(props: { panel: Rect; children: JSX.Element }) {
  const renderer = useRenderer()
  onMount(() => onCleanup(cover()))

  // With no colors to blend with, the cells around the panel are set faint, so the terminal fades them itself.
  const faint = (buffer: OptimizedBuffer) => {
    const { attributes } = buffer.buffers
    const { x, y, width, height } = props.panel
    for (let row = 0; row < buffer.height; row++) {
      for (let column = 0; column < buffer.width; column++) {
        const index = row * buffer.width + column
        if (column < x || column >= x + width || row < y || row >= y + height)
          attributes[index] = (attributes[index] ?? 0) | TextAttributes.DIM
      }
    }
  }
  createEffect(() => {
    if (theme.dim) return
    renderer.addPostProcessFn(faint)
    onCleanup(() => renderer.removePostProcessFn(faint))
  })

  return (
    <>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={10}
        backgroundColor={theme.dim ? SCRIM : undefined}
      />
      <Show when={theme.dim}>
        <DimmedImages panel={props.panel} />
      </Show>
      <box
        position="absolute"
        top={props.panel.y}
        left={props.panel.x}
        zIndex={11}
        width={props.panel.width}
        height={props.panel.height}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        backgroundColor={fill()}
      >
        {props.children}
      </box>
      {/* Without a dim the panel is framed instead; the frame sits on the panel's padding cells. */}
      <Show when={!theme.dim}>
        <box
          position="absolute"
          top={props.panel.y}
          left={props.panel.x}
          zIndex={12}
          width={props.panel.width}
          height={props.panel.height}
          border
          borderColor={theme.panelMuted}
        />
      </Show>
    </>
  )
}
