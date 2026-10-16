import { useRenderer } from "@opentui/solid"
import { createEffect, type JSX } from "solid-js"

// The part of an ask that gives way when the terminal is short. `focus` is the id of the child to keep in view;
// null shows the top, and `fromTop` shows the top first, then brings `focus` into view. A child as tall as the
// viewport is shown from its top. `scope` changes when the content is swapped without the focus changing.
// The scroll happens before the next frame draws, once the layout is known, and again when the viewport resizes.
export function AskScroll(props: { focus: string | null; fromTop?: boolean; scope?: unknown; children: JSX.Element }) {
  const renderer = useRenderer()
  let target: string | null = null
  let fromTop = false
  let pending = false

  createEffect(() => {
    void props.scope
    target = props.focus
    fromTop = props.fromTop ?? false
    pending = true
    renderer.requestRender()
  })

  return (
    <scrollbox
      renderBefore={function () {
        if (!pending) return
        pending = false
        if (target === null || fromTop) this.scrollTo(0)
        if (target === null) return
        const child = this.content.findDescendantById(target)
        if (child && child.height >= this.viewport.height) this.scrollBy({ x: 0, y: child.y - this.viewport.y })
        else this.scrollChildIntoView(target)
      }}
      onSizeChange={() => {
        pending = true
        renderer.requestRender()
      }}
      flexShrink={1}
      flexGrow={0}
      wrapperOptions={{ flexGrow: 0, flexShrink: 1 }}
      viewportOptions={{ flexGrow: 0, flexShrink: 1 }}
      contentOptions={{ minHeight: 0 }}
      verticalScrollbarOptions={{ visible: false }}
    >
      {props.children}
    </scrollbox>
  )
}
