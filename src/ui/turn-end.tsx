import { NativeImage } from "@opentui/core"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createSignal, Match, Show, Switch } from "solid-js"
import type { TurnEnd } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut, formatClock, formatDuration } from "./format.ts"
import { blank, onBackground, trackImage } from "./images.ts"

const SPARK = NativeImage.decode(readFileSync(join(import.meta.dir, "..", "..", "assets", "claude-spark.png")))

export function TurnEndRow(props: { parts: TurnEnd[] }) {
  const [width, setWidth] = createSignal(0)
  const last = () => props.parts.at(-1)
  const duration = () => formatDuration(props.parts.reduce((sum, part) => sum + part.durationMs, 0))
  const clock = () => formatClock(last()?.endedAt ?? 0)
  const errorSuffix = () => ` · ${duration()}`
  const error = () => {
    const part = last()
    return part && !part.interrupted && part.error ? (part.error.split("\n")[0] ?? "") : null
  }

  return (
    <box
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <Switch
        fallback={
          <box flexDirection="row" gap={1}>
            <Show when={!blank()} fallback={<box width={2} height={1} flexShrink={0} />}>
              <image
                ref={trackImage}
                source={onBackground(SPARK, theme.background)}
                width={2}
                height={1}
                flexShrink={0}
              />
            </Show>
            <text fg={theme.text}>{`done in ${duration()} · ${clock()}`}</text>
          </box>
        }
      >
        <Match when={last()?.interrupted}>
          <text fg={theme.warning}>{`interrupted after ${duration()} · ${clock()}`}</text>
        </Match>
        <Match when={error()}>
          {(message) => (
            <text fg={theme.error} wrapMode="none">
              {cut(`✗ ${message()}`, width() - errorSuffix().length) + errorSuffix()}
            </text>
          )}
        </Match>
      </Switch>
    </box>
  )
}
