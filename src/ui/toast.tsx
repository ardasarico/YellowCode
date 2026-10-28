import { theme } from "../theme/theme.ts"

const MIN_WIDTH = 12
const PAD_X = 2

// A short confirmation in the chat's top right corner, over the conversation.
// Half blocks above and below give it half a row of padding on each side.
export function Toast(props: { text: string; width: number }) {
  const size = () => Math.max(MIN_WIDTH, Bun.stringWidth(`✓ ${props.text}`) + PAD_X * 2)
  const pad = " ".repeat(PAD_X)
  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, props.width - size() - 2)}
      width={size()}
      height={3}
      zIndex={2}
      flexDirection="column"
    >
      <text wrapMode="none" fg={theme.frame}>
        {"▄".repeat(size())}
      </text>
      <text wrapMode="none" bg={theme.frame}>
        <span style={{ fg: theme.accent }}>{`${pad}✓ `}</span>
        <span style={{ fg: theme.text }}>{props.text.padEnd(size() - PAD_X - 2)}</span>
      </text>
      <text wrapMode="none" fg={theme.frame}>
        {"▀".repeat(size())}
      </text>
    </box>
  )
}
