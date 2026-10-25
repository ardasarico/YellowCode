import { type Component, createComponent, createMemo, ErrorBoundary, untrack } from "solid-js"
import type { ModOverridePoints, ModWrap } from "./api.ts"
import { reportModError, wrapsOf } from "./registry.ts"

// One mod's wrap over the part below it; a throw, building it or drawing it, turns the mod off and draws the part below.
function layer<P extends ModOverridePoints[keyof ModOverridePoints]>(
  mod: string,
  wrap: ModWrap<P>,
  inner: Component<P>,
): Component<P> {
  let built: Component<P>
  try {
    built = wrap(inner)
  } catch (error) {
    queueMicrotask(() => reportModError(mod, error))
    return inner
  }
  return (props) => (
    <ErrorBoundary
      fallback={(error: unknown) => {
        queueMicrotask(() => reportModError(mod, error))
        return createComponent(inner, props)
      }}
    >
      {createComponent(built, props)}
    </ErrorBoundary>
  )
}

// A part of the screen mods may wrap; with no wraps it is the original.
export function overridable<K extends keyof ModOverridePoints>(
  point: K,
  Original: Component<ModOverridePoints[K]>,
): Component<ModOverridePoints[K]> {
  return (props) => {
    const chain = createMemo(() =>
      wrapsOf(point).reduce<Component<ModOverridePoints[K]>>(
        (inner, entry) => layer(entry.mod, entry.wrap, inner),
        Original,
      ),
    )
    return (
      <>
        {(() => {
          const Drawn = chain()
          return untrack(() => createComponent(Drawn, props))
        })()}
      </>
    )
  }
}
