import { CliRenderEvents, type CliRenderer, type TerminalCapabilities, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Index, Show } from "solid-js"
import { theme } from "../theme/theme.ts"
import { PixelArt } from "./pixel-art.tsx"
import { barChars } from "./user-message.tsx"
import { wordmarkPalette } from "./welcome.tsx"
import { wordmark } from "./wordmark.ts"

export type TerminalProblem = { kind: "tmux" } | { kind: "no-graphics"; terminal: string }

const ANSWER_MS = 500
const WORDMARK = wordmark()
const WORDMARK_ROWS = 26
const NAMES: Record<string, string> = { Apple_Terminal: "Terminal.app" }
const BREAKS = ["images and screenshots Claude shows", "previews of images you paste", "the cat"]
const CHOICES = ["Continue anyway", "Quit"]
const HINTS: [string, string][] = [
  ["↑↓", "select"],
  ["enter", "confirm"],
  ["esc", "quit"],
]

// What the renderer knows before the terminal answers is a guess from the environment, so only the first answer
// counts. A terminal that never answers is taken as supported.
export function firstCapabilities(renderer: CliRenderer): Promise<TerminalCapabilities | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ANSWER_MS)
    renderer.once(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) => {
      clearTimeout(timer)
      resolve(capabilities)
    })
  })
}

export function terminalProblem(capabilities: TerminalCapabilities | null): TerminalProblem | null {
  if (!capabilities) return null
  if (capabilities.multiplexer !== "none") return { kind: "tmux" }
  if (capabilities.kitty_graphics) return null
  const name = capabilities.terminal.name
  return { kind: "no-graphics", terminal: NAMES[name] ?? (name || "unknown terminal") }
}

function Hints() {
  return (
    <text>
      <Index each={HINTS}>
        {(hint, index) => (
          <>
            <span style={{ fg: theme.text }}>{`${index === 0 ? "" : "   "}${hint()[0]}`}</span>
            <span style={{ fg: theme.muted }}>{` ${hint()[1]}`}</span>
          </>
        )}
      </Index>
    </text>
  )
}

export function TerminalCheck(props: { problem: TerminalProblem; onContinue: () => void; onQuit: () => void }) {
  const dimensions = useTerminalDimensions()
  const [cursor, setCursor] = createSignal(0)
  const choose = (index: number) => (index === 0 ? props.onContinue() : props.onQuit())
  const tmux = () => props.problem.kind === "tmux"
  const detected = () => (props.problem.kind === "tmux" ? "tmux" : props.problem.terminal)
  const showWordmark = () =>
    dimensions().height >= WORDMARK_ROWS && dimensions().width >= (WORDMARK[0]?.length ?? 0) + 4

  useKeyboard((key) => {
    // The app's prompt mounts during this key event when Continue is picked, and would get the key too.
    key.preventDefault()
    if (key.name === "escape" || (key.ctrl && key.name === "c")) props.onQuit()
    else if (key.name === "up") setCursor(0)
    else if (key.name === "down") setCursor(CHOICES.length - 1)
    else if (key.name === "return") choose(cursor())
    else if (key.name === "1") choose(0)
    else if (key.name === "2") choose(1)
  })

  return (
    <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
      <Show when={showWordmark()}>
        <PixelArt art={WORDMARK} palette={wordmarkPalette()} />
        <box height={1} />
      </Show>
      <box
        flexDirection="column"
        maxWidth={Math.max(0, dimensions().width - 4)}
        flexShrink={0}
        paddingX={2}
        paddingY={1}
        backgroundColor={theme.tile ?? theme.band ?? undefined}
        border={["left"]}
        borderColor={theme.warning}
        customBorderChars={barChars}
      >
        <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="word">
          {tmux() ? "⚠  tmux doesn't pass images through" : "⚠  This terminal can't show images"}
        </text>
        <text fg={theme.muted} wrapMode="word">{`Detected: ${detected()}`}</text>
        <box height={1} />
        <text fg={theme.text} wrapMode="word">
          {tmux()
            ? "YellowCode draws images with the kitty graphics protocol,\nwhich tmux does not forward."
            : "YellowCode draws images with the kitty graphics protocol."}
        </text>
        <text fg={theme.text} wrapMode="word">
          In this terminal these look broken or don't show:
        </text>
        <box height={1} />
        <Index each={BREAKS}>
          {(item) => (
            <text wrapMode="word">
              <span style={{ fg: theme.muted }}>· </span>
              <span style={{ fg: theme.text }}>{item()}</span>
            </text>
          )}
        </Index>
        <box height={1} />
        <Show
          when={!tmux()}
          fallback={
            <text fg={theme.text} wrapMode="word">
              Recommended: run YellowCode outside tmux
            </text>
          }
        >
          <text fg={theme.text} wrapMode="word">
            {"Recommended: "}
            <span style={{ bold: true }}>Ghostty</span>
            {"  "}
            <a href="https://ghostty.org" style={{ fg: theme.accent, underline: true }}>
              ghostty.org
            </a>
            {"  or "}
            <span style={{ bold: true }}>kitty</span>
            {"  "}
            <a href="https://sw.kovidgoyal.net/kitty/" style={{ fg: theme.accent, underline: true }}>
              sw.kovidgoyal.net/kitty
            </a>
          </text>
        </Show>
        <box height={1} />
        <Index each={CHOICES}>
          {(choice, index) => {
            const color = () => (cursor() === index ? theme.accent : theme.text)
            return (
              <text onMouseDown={() => choose(index)}>
                <span style={{ fg: color() }}>{cursor() === index ? "❯ " : "  "}</span>
                <span style={{ fg: color() }}>{`${index + 1}. ${choice()}`}</span>
              </text>
            )
          }}
        </Index>
      </box>
      <box marginTop={1} flexShrink={0}>
        <Hints />
      </box>
    </box>
  )
}
