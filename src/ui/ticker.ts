import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"

export function useTicker(active: () => boolean, ms: number): Accessor<number> {
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => setTick((value) => value + 1), ms)
    onCleanup(() => clearInterval(timer))
  })
  return tick
}
