import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"

export function useElapsedSeconds(active: () => boolean): Accessor<number> {
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    if (!active()) return
    const start = Date.now()
    setSeconds(0)
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250)
    onCleanup(() => clearInterval(timer))
  })
  return seconds
}
