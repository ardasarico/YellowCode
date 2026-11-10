import { createMemo, createSignal, Match, Switch } from "solid-js"
import type { AskReply, Matrix, QuestionPage } from "../../agent/ask.ts"
import type { Capabilities } from "../../agent/capabilities.ts"
import type { Ask, ChatImage, Session } from "../../session/types.ts"
import { MatrixAsk } from "./matrix-ask.tsx"
import { PlanBand } from "./plan-band.tsx"
import { PermissionBand } from "./permission-band.tsx"
import { QuestionAsk } from "./question-ask.tsx"

// A view reads keys with its own useKeyboard. While it is open, App passes on every key except Ctrl+C and F3.
// The surface passes on only the first reply per ask; `answered` turns true once it is out, and the view then ignores
// keys.
export type AskViewProps = {
  ask: Ask
  width: number
  // The agent's short name, for the notes' texts.
  agent: string
  answered: boolean
  onAnswer: (reply: AskReply) => void
  onOpenImages?: (images: ChatImage[], index: number) => void
  onOpenText?: (path: string, text: string) => void
  onPlanApproved?: () => void
}

export type AskSurfaceProps = Omit<AskViewProps, "onAnswer" | "answered"> & {
  caps: Pick<Capabilities, "askNote">
  onAnswer: (ask: Ask, reply: AskReply) => void
}

export function pendingAsk(session: Session): Ask | null {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "ask" && item.status === "pending") return item
  }
  return null
}

export const asksQuestions = (ask: Pick<Ask, "toolKind">) => ask.toolKind === "question"

// An ask with no pages or matrix is shown as a plain permission with its options.
export function AskSurface(props: AskSurfaceProps) {
  const [answered, setAnswered] = createSignal(false)
  const answer = (reply: AskReply) => {
    if (answered()) return
    setAnswered(true)
    props.onAnswer(props.ask, reply)
  }
  const view = createMemo((): { pages?: QuestionPage[]; matrix?: Matrix } | null => {
    const questions = props.ask.questions
    if (questions && "pages" in questions) return { pages: questions.pages }
    if (questions && "matrix" in questions) return { matrix: questions.matrix }
    return null
  })
  return (
    <Switch
      fallback={
        <PermissionBand
          ask={props.ask}
          width={props.width}
          agent={props.agent}
          answered={answered()}
          onAnswer={answer}
          onOpenText={props.onOpenText}
          note={props.caps.askNote}
        />
      }
    >
      <Match when={props.ask.toolKind === "plan"}>
        <PlanBand
          ask={props.ask}
          width={props.width}
          agent={props.agent}
          answered={answered()}
          onAnswer={answer}
          onPlanApproved={props.onPlanApproved}
        />
      </Match>
      <Match when={view()?.matrix}>
        {(matrix) => (
          <MatrixAsk
            ask={props.ask}
            matrix={matrix()}
            width={props.width}
            agent={props.agent}
            answered={answered()}
            onAnswer={answer}
          />
        )}
      </Match>
      <Match when={view()?.pages}>
        {(pages) => (
          <QuestionAsk
            ask={props.ask}
            pages={pages()}
            width={props.width}
            agent={props.agent}
            answered={answered()}
            onAnswer={answer}
            onOpenImages={props.onOpenImages}
          />
        )}
      </Match>
    </Switch>
  )
}
