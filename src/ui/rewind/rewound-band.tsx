import { TextAttributes } from "@opentui/core"
import type { Rewound } from "../../session/rewind.ts"
import { createSignal, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { cut, pad } from "../format.ts"

const HINT = "/redo to bring back"
// A longer list shows this many files and a "+N more" line.
const MAX_FILES = 6

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

// Closes the chat while prompts are rewound, with the files that went back; a click brings them back, like /redo.
export function RewoundBand(props: { rewound: Rewound; onRedo: () => void }) {
  const restored = () => (props.rewound.keptFiles ? [] : props.rewound.files)
  const files = () =>
    props.rewound.keptFiles
      ? "files kept"
      : restored().length > 0
        ? `${plural(restored().length, "file")} restored`
        : "no files changed"
  const [width, setWidth] = createSignal(0)
  const text = () => `↶ ${plural(props.rewound.prompts, "prompt")} rewound · ${files()}`
  // The hint goes first when the band is too narrow for both.
  const hint = () => Bun.stringWidth(text()) + HINT.length + 2 <= width()
  const shown = () => (restored().length > MAX_FILES ? restored().slice(0, MAX_FILES - 1) : restored())
  const column = () =>
    Math.min(Math.max(0, ...shown().map((file) => Bun.stringWidth(file.path))), Math.max(0, width() - 20))
  return (
    <box
      marginTop={1}
      paddingX={1}
      onSizeChange={function () {
        setWidth(this.width - 2)
      }}
      backgroundColor={theme.warningBand ?? theme.band ?? theme.tile ?? undefined}
      onMouseDown={(event) => {
        event.preventDefault()
        props.onRedo()
      }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text wrapMode="none" flexShrink={1}>
          <span style={{ fg: theme.accent }}>{"↶ "}</span>
          <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>
            {`${plural(props.rewound.prompts, "prompt")} rewound`}
          </span>
          <span style={{ fg: theme.muted }}>{` · ${files()}`}</span>
        </text>
        <Show when={hint()}>
          <text wrapMode="none" flexShrink={0} fg={theme.faint}>
            {HINT}
          </text>
        </Show>
      </box>
      <For each={shown()}>
        {(file) => (
          <text wrapMode="none">
            <span style={{ fg: theme.muted }}>{`  ${pad(cut(file.path, column()), column())}  `}</span>
            <Show when={file.plus > 0}>
              <span style={{ fg: theme.diffAddText }}>{`+${file.plus} `}</span>
            </Show>
            <Show when={file.minus > 0}>
              <span style={{ fg: theme.diffDelText }}>{`−${file.minus} `}</span>
            </Show>
            <Show when={file.bash}>
              <span style={{ fg: theme.faint }}>bash</span>
            </Show>
          </text>
        )}
      </For>
      <Show when={restored().length > shown().length}>
        <text wrapMode="none" fg={theme.faint}>
          {`  +${restored().length - shown().length} more`}
        </text>
      </Show>
    </box>
  )
}
