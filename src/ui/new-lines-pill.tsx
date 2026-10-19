import { theme } from "../theme/theme.ts"

export type NewLines = { lines: number; onClick: () => void }

// Sits centred on the row just above the prompt's top rule while the user reads above new output.
export function NewLinesPill(props: NewLines & { width: number; top: number }) {
  const count = () => ` ↓ ${props.lines} new ${props.lines === 1 ? "line" : "lines"}`
  const hint = " · click or End "
  const size = () => Bun.stringWidth(count() + hint)
  return (
    <box
      position="absolute"
      top={props.top}
      left={Math.max(0, Math.floor((props.width - size()) / 2))}
      width={size()}
      height={1}
      zIndex={1}
      backgroundColor={theme.frame}
      onMouseDown={(event) => {
        event.preventDefault()
        props.onClick()
      }}
    >
      <text wrapMode="none">
        <span style={{ fg: theme.accent }}>{count()}</span>
        <span style={{ fg: theme.text }}>{hint}</span>
      </text>
    </box>
  )
}
