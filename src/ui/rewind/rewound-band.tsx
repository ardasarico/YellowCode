import { TextAttributes } from "@opentui/core"
import type { Rewound } from "../../session/rewind.ts"
import { createSignal, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"

const HINT = "/redo to bring back"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

// Closes the chat while prompts are rewound; a click brings them back, like /redo.
export function RewoundBand(props: { rewound: Rewound; onRedo: () => void }) {
  const files = () =>
    props.rewound.keptFiles
      ? "files kept"
      : props.rewound.files > 0
        ? `${plural(props.rewound.files, "file")} restored`
        : "no files changed"
  const [width, setWidth] = createSignal(0)
  const text = () => `↶ ${plural(props.rewound.prompts, "prompt")} rewound · ${files()}`
  // The hint goes first when the band is too narrow for both.
  const hint = () => Bun.stringWidth(text()) + HINT.length + 2 <= width()
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
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
  )
}
