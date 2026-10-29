import { overridable } from "../mods/overridable.tsx"
import { NativeImage } from "@opentui/core"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createContext, createSignal, Match, Show, Switch, useContext } from "solid-js"
import type { TurnEnd } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut, formatClock, formatDuration } from "./format.ts"
import { blank, onBackground, trackImage } from "./images.ts"

// Each mark belongs to the agent's maker and is shown only to say which agent answered. YellowCode is not a product of
// Anthropic, OpenAI or opencode.
const asset = (name: string) => NativeImage.decode(readFileSync(join(import.meta.dir, "..", "..", "assets", name)))
const SPARK = asset("claude-spark.png")
const CODEX = asset("codex-mark.png")
const MARKS: Record<string, { dark: NativeImage; light: NativeImage }> = {
  claude: { dark: SPARK, light: SPARK },
  codex: { dark: CODEX, light: CODEX },
  opencode: { dark: asset("opencode-mark-dark.png"), light: asset("opencode-mark-light.png") },
}

// The id of the agent whose chat this is.
export const AgentOfChat = createContext<() => string>()

// `waiting` counts the background agents still running after the latest turn; the agent goes on when they finish.
export type TurnEndRowProps = { parts: TurnEnd[]; waiting: number }

function TurnEndRowBase(props: TurnEndRowProps) {
  const [width, setWidth] = createSignal(0)
  const last = () => props.parts.at(-1)
  const duration = () => formatDuration(props.parts.reduce((sum, part) => sum + part.durationMs, 0))
  const clock = () => formatClock(last()?.endedAt ?? 0)
  const errorSuffix = () => {
    const retries = last()?.retries ?? 0
    return `${retries > 0 ? ` · after ${retries} ${retries === 1 ? "retry" : "retries"}` : ""} · ${duration()}`
  }
  const agent = useContext(AgentOfChat)
  const mark = () => {
    const marks = MARKS[agent?.() ?? ""]
    if (!marks) return null
    const { r, g, b } = theme.canvas
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? marks.light : marks.dark
  }
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
            <Show when={mark()}>
              {(image) => (
                <Show when={!blank()} fallback={<box width={2} height={1} flexShrink={0} />}>
                  <image
                    ref={trackImage}
                    source={onBackground(image(), theme.background)}
                    width={2}
                    height={1}
                    flexShrink={0}
                  />
                </Show>
              )}
            </Show>
            <text fg={theme.text}>{`done in ${duration()} · ${clock()}`}</text>
          </box>
        }
      >
        <Match when={last()?.interrupted}>
          <text fg={theme.warning}>{`interrupted after ${duration()} · ${clock()}`}</text>
        </Match>
        <Match when={!last()?.error && props.waiting > 0}>
          <text fg={theme.muted}>
            {`✻ waiting for ${props.waiting} background ${props.waiting === 1 ? "agent" : "agents"} to finish`}
          </text>
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

export const TurnEndRow = overridable("turn-end", TurnEndRowBase)
