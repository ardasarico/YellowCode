import { createMemo, createSignal, Match, Switch } from "solid-js"
import { type AskMatrix, askUserQuestionInput, OWN_ASK, ownAskMatrix, ownAskPages } from "../../protocol/messages.ts"
import { ownAskProblem } from "../../session/ask.ts"
import type { Ask, ChatImage, Session } from "../../session/types.ts"
import { MatrixAsk } from "./matrix-ask.tsx"
import { PlanBand } from "./plan-band.tsx"
import { PermissionBand } from "./permission-band.tsx"
import { QuestionAsk } from "./question-ask.tsx"
import type { QuestionInput } from "./question.ts"

// A view reads keys with its own useKeyboard. While it is open, App passes on every key except Ctrl+C and F3.
// `onAnswer` takes the outgoing control_response line; the surface passes on only the first one per ask.
// `answered` turns true once a response is out; the view then ignores keys.
export type AskViewProps = {
  ask: Ask
  width: number
  answered: boolean
  onAnswer: (response: string) => void
  onOpenImages?: (images: ChatImage[], index: number) => void
  onOpenScript?: (name: string, script: string) => void
  onPlanApproved?: () => void
}

export type AskSurfaceProps = Omit<AskViewProps, "onAnswer" | "answered"> & {
  onAnswer: (ask: Ask, response: string) => void
}

// A broken own ask is never shown: it goes straight back to Claude.
export function pendingAsk(session: Session): Ask | null {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "ask" && item.status === "pending" && ownAskProblem(item) === null) return item
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
  const view = createMemo((): { matrix?: AskMatrix; questions?: QuestionInput } | null => {
    const { toolName, input } = props.ask
    if (toolName === "AskUserQuestion") {
      const stock = askUserQuestionInput.safeParse(input).data
      return stock ? { questions: stock } : null
    }
    if (toolName !== OWN_ASK) return null
    const pages = ownAskPages.safeParse(input).data
    if (pages) return { questions: pages }
    const matrix = ownAskMatrix.safeParse(input).data?.matrix
    return matrix ? { matrix } : null
  })
  return (
    <Switch
      fallback={
        <PermissionBand
          ask={props.ask}
          width={props.width}
          answered={answered()}
          onAnswer={answer}
          onOpenScript={props.onOpenScript}
        />
      }
    >
      <Match when={props.ask.toolName === "ExitPlanMode"}>
        <PlanBand
          ask={props.ask}
          width={props.width}
          answered={answered()}
          onAnswer={answer}
          onPlanApproved={props.onPlanApproved}
        />
      </Match>
      <Match when={view()?.matrix}>
        {(matrix) => (
          <MatrixAsk ask={props.ask} matrix={matrix()} width={props.width} answered={answered()} onAnswer={answer} />
        )}
      </Match>
      <Match when={view()?.questions}>
        {(input) => (
          <QuestionAsk
            ask={props.ask}
            input={input()}
            width={props.width}
            answered={answered()}
            onAnswer={answer}
            onOpenImages={props.onOpenImages}
          />
        )}
      </Match>
    </Switch>
  )
}
