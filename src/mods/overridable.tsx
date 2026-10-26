import { type Component, createComponent, createMemo, ErrorBoundary, mergeProps, untrack } from "solid-js"
import type { ModOverridePoints, ModWrap } from "./api.ts"
import { raisedByMod } from "./mods.ts"
import { reportModError, wrapsOf } from "./registry.ts"

// One mod's wrap over the part below it; a throw, building it or drawing it, turns the mod off and draws the part below.
// A throw drawn inside the wrap whose stack does not reach the mod's folder is the app's own and passes on.
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
        if (!raisedByMod(mod, error)) throw error
        queueMicrotask(() => reportModError(mod, error))
        return createComponent(inner, props)
      }}
    >
      {createComponent(built, props)}
    </ErrorBoundary>
  )
}

// A part of the screen mods may wrap; with no wraps it is the original. Its props must hold what the point promises;
// mods see only that, but the whole props pass through to the original.
export function overridable<K extends keyof ModOverridePoints, P extends ModOverridePoints[K]>(
  point: K,
  Original: Component<P>,
): Component<P> {
  return (props) => {
    const chain = createMemo(() =>
      wrapsOf(point).reduce<Component<ModOverridePoints[K]>>(
        (inner, entry) => layer(entry.mod, entry.wrap, inner),
        (given) => {
          // `props` is the part's whole props; a wrap's changes go over them, typed as the fields mods can see.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mods see a subset by design
          const whole = mergeProps(props, given) as P // SAFETY: every field of P is in `props`
          return createComponent(Original, whole)
        },
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
