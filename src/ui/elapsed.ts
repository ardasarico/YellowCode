import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

export function useElapsedSeconds(active: () => boolean): Accessor<number> {
  const [seconds, setSeconds] = createSignal(0)
  // Only a change of the flag itself restarts the count, not a change in whatever it is computed from.
  const isActive = createMemo(active)
  createEffect(() => {
    if (!isActive()) return
    const start = Date.now()
    setSeconds(0)
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250)
    onCleanup(() => clearInterval(timer))
  })
  return seconds
}
