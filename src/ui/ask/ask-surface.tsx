import { createMemo, createSignal, Show } from "solid-js"
import { askUserQuestionInput } from "../../protocol/messages.ts"
import type { Ask, Session } from "../../session/types.ts"
import { PermissionBand } from "./permission-band.tsx"
import { QuestionAsk } from "./question-ask.tsx"

// A view reads keys with its own useKeyboard. While it is open, App passes on every key except Ctrl+C and F3.
// `onAnswer` takes the outgoing control_response line; the surface passes on only the first one per ask.
// `answered` turns true once a response is out; the view then ignores keys.
export type AskViewProps = {
  ask: Ask
  width: number
  answered: boolean
  onAnswer: (response: string) => void
}

export type AskSurfaceProps = Omit<AskViewProps, "onAnswer" | "answered"> & {
  onAnswer: (ask: Ask, response: string) => void
}

export function pendingAsk(session: Session): Ask | null {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "ask" && item.status === "pending") return item
  }
  return null
}

// A question whose input does not parse is shown as a plain permission, so it can still be answered.
export function AskSurface(props: AskSurfaceProps) {
  const [answered, setAnswered] = createSignal(false)
  const answer = (response: string) => {
    if (answered()) return
    setAnswered(true)
    props.onAnswer(props.ask, response)
  }
  const questions = createMemo(() =>
    props.ask.toolName === "AskUserQuestion" ? askUserQuestionInput.safeParse(props.ask.input).data : undefined,
  )
  return (
    <Show
      when={questions()}
      fallback={<PermissionBand ask={props.ask} width={props.width} answered={answered()} onAnswer={answer} />}
    >
      {(input) => (
        <QuestionAsk ask={props.ask} input={input()} width={props.width} answered={answered()} onAnswer={answer} />
      )}
    </Show>
  )
}
